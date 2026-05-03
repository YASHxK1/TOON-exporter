/**
 * content.js — FloatTab Content Script
 *
 * Injected into every tab. Responsibilities:
 * - Listen for INJECT_DOC_PIP from the service worker
 * - Open a Document PiP window using the Document Picture-in-Picture API
 * - Inject an iframe pointing to the current page URL into that window
 * - Copy host stylesheets into the PiP document for visual consistency
 * - If the iframe fails to load (CSP / X-Frame-Options at runtime), signal the
 *   service worker to fall back to mirror mode
 * - Listen for CLOSE_DOC_PIP to programmatically close the window
 * - Detect when the user closes the PiP window natively and sync popup state
 */

(function () {
  "use strict";

  // Prevent multiple injections — if we already set up the listener, bail out
  if (window.__floatTabInitialized) return;
  window.__floatTabInitialized = true;

  // Expose a global entry point so popup.js can trigger PiP via
  // chrome.scripting.executeScript(), which preserves the user gesture context
  // far more reliably than the SW message chain.
  window.__floatTabOpen = () => openDocumentPiP();
  window.__floatTabClose = () => closeDocumentPiP();

  /** Reference to the currently open Document PiP window (if any) */
  let pipWindow = null;

  /** Whether we have already triggered a fallback for this PiP session */
  let fallbackTriggered = false;

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "INJECT_DOC_PIP") {
      // Kick off PiP asynchronously; we must respond promptly
      openDocumentPiP()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // Keep channel open for async response
    }

    if (message.type === "CLOSE_DOC_PIP") {
      closeDocumentPiP();
      sendResponse({ success: true });
      return false;
    }
  });

  // ---------------------------------------------------------------------------
  // Open Document PiP window
  // ---------------------------------------------------------------------------

  async function openDocumentPiP() {
    // Guard: Document PiP API availability (Chrome 116+)
    if (!("documentPictureInPicture" in window)) {
      return {
        success: false,
        error: "DOC_PIP_UNSUPPORTED",
      };
    }

    // Close any existing PiP window before opening a new one
    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
    }

    fallbackTriggered = false;

    try {
      // Request the Document PiP window.
      // IMPORTANT: This call must happen synchronously within a user gesture chain.
      // The popup button click → chrome.runtime.sendMessage → onMessage handler →
      // content.js message handler → this function.  MV3 preserves the user gesture
      // context through synchronous message forwarding, so requestWindow() is valid here.
      // Landscape 16:9 dimensions as required by spec
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 854,
        height: 480,
      });
    } catch (err) {
      // requestWindow can fail if: no user gesture, Chrome < 116, or API removed
      return { success: false, error: `requestWindow failed: ${err.message}` };
    }

    // Style the PiP window's body — full-screen, no margins
    const pipDoc = pipWindow.document;
    pipDoc.documentElement.style.cssText = "margin:0;padding:0;width:100%;height:100%;";
    pipDoc.body.style.cssText = "margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;position:relative;";

    // Copy all stylesheets from the host document into the PiP document.
    // This ensures any chrome-global or extension styles are available, and
    // provides visual continuity for the floating window chrome.
    copyStylesheets(document, pipDoc);

    // Inject an iframe pointing to the current page URL.
    // Use position:absolute + inset:0 so it always fills the entire PiP window
    // regardless of the window's own sizing quirks.
    const iframe = pipDoc.createElement("iframe");
    iframe.src = window.location.href;
    iframe.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;border:none;display:block;";
    iframe.id = "floattab-iframe";

    // Detect iframe load failure (CSP / X-Frame-Options runtime block)
    iframe.addEventListener("error", handleIframeError);

    // The 'load' event fires even when embedding is blocked (the browser shows
    // an error page inside the iframe).  We use a heuristic: if the iframe's
    // contentDocument is null after load, the site blocked embedding.
    iframe.addEventListener("load", () => {
      try {
        // Cross-origin access to contentDocument will throw if blocked
        const doc = iframe.contentDocument;
        if (!doc || doc.body === null) {
          handleIframeError();
        }
      } catch (_) {
        // Security error → cross-origin, which is expected and fine.
        // The iframe loaded successfully into its sandboxed origin.
      }
    });

    pipDoc.body.appendChild(iframe);

    // Listen for the user closing the PiP window via the native close button (×)
    pipWindow.addEventListener("pagehide", () => {
      pipWindow = null;
      // Notify the service worker so it can reset popup state
      chrome.runtime.sendMessage({ type: "PIP_CLOSED_BY_USER" }).catch(() => {});
    });

    return { success: true, mode: "interactive" };
  }

  // ---------------------------------------------------------------------------
  // Iframe error → fallback to mirror mode
  // ---------------------------------------------------------------------------

  function handleIframeError() {
    if (fallbackTriggered) return;
    fallbackTriggered = true;

    // Close the Document PiP window (it was showing a broken/empty iframe)
    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
      pipWindow = null;
    }

    // Signal service worker to fall back to mirror mode
    chrome.runtime
      .sendMessage({ type: "PIP_FALLBACK_TO_MIRROR" })
      .catch((err) => console.warn("[FloatTab] Fallback message failed:", err));
  }

  // ---------------------------------------------------------------------------
  // Close Document PiP (called by service worker on CLOSE_PIP)
  // ---------------------------------------------------------------------------

  function closeDocumentPiP() {
    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
    }
    pipWindow = null;
    fallbackTriggered = false;
  }

  // ---------------------------------------------------------------------------
  // Stylesheet copying
  // ---------------------------------------------------------------------------

  /**
   * Copies all <link rel="stylesheet"> and <style> elements from the source
   * document into the target document (the PiP window document).
   * This gives the PiP window chrome (scrollbars, font rendering) the same
   * base styles as the host page, improving visual consistency.
   *
   * @param {Document} sourceDoc - The host page document
   * @param {Document} targetDoc - The PiP window document
   */
  function copyStylesheets(sourceDoc, targetDoc) {
    const elements = [
      ...sourceDoc.querySelectorAll('link[rel="stylesheet"], style'),
    ];

    for (const el of elements) {
      try {
        const clone = targetDoc.importNode(el, true);
        targetDoc.head.appendChild(clone);
      } catch (err) {
        // Cross-origin stylesheets may throw on importNode — skip them
        console.warn("[FloatTab] Could not copy stylesheet:", err);
      }
    }
  }
})();
