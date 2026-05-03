/**
 * service_worker.js — FloatTab Central Orchestrator
 *
 * Responsibilities:
 * - Listen for OPEN_PIP / CLOSE_PIP messages from popup.js
 * - Check if the active tab's URL is embeddable (no X-Frame-Options / restrictive CSP)
 * - Route to Mode A (interactive iframe via content.js) or Mode B (tab capture via offscreen.js)
 * - Manage the offscreen document lifecycle (MV3: only one per extension, must be reused)
 * - Maintain pip state per tab
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * pipState holds the current PiP status for the extension.
 * Only one PiP window is supported at a time in v1.0.
 * @type {{ active: boolean, mode: 'interactive'|'mirror'|null, tabId: number|null }}
 */
let pipState = {
  active: false,
  mode: null,
  tabId: null,
};

/** Tracks whether an offscreen document has been created already */
let offscreenCreated = false;

// ---------------------------------------------------------------------------
// Header cache — populated by webRequest listener, used to decide embeddability
// ---------------------------------------------------------------------------

/**
 * Map from tabId → { xFrameOptions: string|null, csp: string|null }
 * We capture headers on every navigation so we have them ready when the user
 * clicks the popup button.
 */
const headerCache = new Map();

// Listen to completed web requests for main_frame navigations so we can cache
// the response headers for embeddability checking.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type !== "main_frame") return;

    let xfo = null;
    let csp = null;

    for (const header of details.responseHeaders || []) {
      const name = header.name.toLowerCase();
      if (name === "x-frame-options") {
        xfo = header.value.toLowerCase();
      }
      if (name === "content-security-policy") {
        csp = header.value.toLowerCase();
      }
    }

    headerCache.set(details.tabId, { xFrameOptions: xfo, csp });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clean up header cache when a tab is removed
chrome.tabs.onRemoved.addListener((tabId) => {
  headerCache.delete(tabId);
  // If the closed tab had an active PiP, reset state
  if (pipState.tabId === tabId) {
    resetPipState();
  }
});

// ---------------------------------------------------------------------------
// Embeddability check
// ---------------------------------------------------------------------------

/**
 * Determines whether a URL is safe to embed in an iframe.
 *
 * Checks:
 * 1. Cached X-Frame-Options header (deny / sameorigin → not embeddable)
 * 2. Cached CSP frame-ancestors directive (anything other than * → not embeddable)
 * 3. Special URL schemes (chrome://, chrome-extension://, etc.) → not embeddable
 *
 * @param {string} url - The page URL to check
 * @param {number} tabId - The tab id whose headers we cached
 * @returns {boolean} true if the site appears safe to iframe
 */
function isEmbeddable(url, tabId) {
  // Reject special browser pages immediately
  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url.startsWith("devtools://")
  ) {
    return false;
  }

  const cached = headerCache.get(tabId);
  if (!cached) {
    // No cached headers — optimistically assume embeddable; content.js will
    // signal back if the iframe actually fails to load.
    return true;
  }

  // X-Frame-Options: DENY or SAMEORIGIN both block cross-origin embedding
  if (cached.xFrameOptions) {
    const xfo = cached.xFrameOptions.trim();
    if (xfo === "deny" || xfo === "sameorigin") {
      return false;
    }
  }

  // CSP frame-ancestors: a value other than '*' is restrictive
  if (cached.csp) {
    const match = cached.csp.match(/frame-ancestors\s+([^;]+)/);
    if (match) {
      const val = match[1].trim();
      // 'none' always blocks; anything without a wildcard is treated as restricted
      if (val === "'none'" || (!val.includes("*") && val !== "")) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Returns true if the URL belongs to a page we should never attempt to float.
 * @param {string} url
 */
function isRestrictedUrl(url) {
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url.startsWith("devtools://") ||
    url === "" ||
    !url.startsWith("http")
  );
}

// ---------------------------------------------------------------------------
// Offscreen document management
// ---------------------------------------------------------------------------

/**
 * Ensures the offscreen document exists.
 * MV3 rule: only one offscreen document per extension — reuse if it exists.
 */
async function ensureOffscreenDocument() {
  if (offscreenCreated) return;

  // Check if an offscreen document already exists (e.g., from a previous SW lifecycle)
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (contexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL("offscreen/offscreen.html"),
    reasons: ["USER_MEDIA"],
    justification: "Capture tab video stream for mirror-mode PiP window",
  });

  offscreenCreated = true;
}

/**
 * Closes the offscreen document and resets the created flag.
 */
async function closeOffscreenDocument() {
  if (!offscreenCreated) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) {
    // Already closed or never existed — ignore
  }
  offscreenCreated = false;
}

// ---------------------------------------------------------------------------
// PiP state helpers
// ---------------------------------------------------------------------------

function resetPipState() {
  pipState = { active: false, mode: null, tabId: null };
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {

      // Popup queries embeddability synchronously from cached headers
      case "CHECK_EMBEDDABLE": {
        const embeddable = isEmbeddable(message.url || "", message.tabId);
        sendResponse({ embeddable });
        break;
      }

      // Popup uses executeScript for interactive mode; SW only handles mirror
      case "OPEN_MIRROR_PIP": {
        // We need a tab object — get it from the provided tabId
        try {
          const tab = await chrome.tabs.get(message.tabId);
          await startMirrorMode(tab, sendResponse);
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      // Popup notifies SW of state after executeScript-based interactive open
      case "SET_PIP_STATE":
        pipState = { active: true, mode: message.mode, tabId: message.tabId };
        sendResponse({ success: true });
        break;

      case "CLOSE_PIP":
        await handleClosePip(sendResponse);
        break;

      case "GET_PIP_STATE":
        sendResponse({ success: true, pipState });
        break;

      // content.js signals iframe blocked — fall back to mirror
      case "PIP_FALLBACK_TO_MIRROR":
        await handleFallbackToMirror(sender.tab, sendResponse);
        break;

      case "PIP_CLOSED_BY_USER":
        resetPipState();
        sendResponse({ success: true });
        break;

      case "MIRROR_PIP_ENDED":
        resetPipState();
        await closeOffscreenDocument();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: "Unknown message type" });
    }
  })();

  return true; // Keep channel open for async sendResponse
});

// ---------------------------------------------------------------------------
// CLOSE_PIP handler
// ---------------------------------------------------------------------------

async function handleClosePip(sendResponse) {
  try {
    if (pipState.mode === "interactive" && pipState.tabId !== null) {
      // Tell content.js to close the PiP window
      try {
        await chrome.tabs.sendMessage(pipState.tabId, { type: "CLOSE_DOC_PIP" });
      } catch (_) {
        // Tab may have navigated — ignore
      }
    } else if (pipState.mode === "mirror") {
      // Tell offscreen.js to stop the capture
      try {
        await chrome.runtime.sendMessage({ type: "STOP_MIRROR_PIP" });
      } catch (_) {}
      await closeOffscreenDocument();
    }

    resetPipState();
    sendResponse({ success: true });
  } catch (err) {
    console.error("[FloatTab SW] handleClosePip error:", err);
    sendResponse({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Fallback to mirror mode (called by content.js when iframe load fails)
// ---------------------------------------------------------------------------

async function handleFallbackToMirror(tab, sendResponse) {
  if (!tab) {
    sendResponse({ success: false, error: "No tab info in fallback" });
    return;
  }
  await startMirrorMode(tab, sendResponse);
}

// ---------------------------------------------------------------------------
// Mirror mode startup
// ---------------------------------------------------------------------------

async function startMirrorMode(tab, sendResponse) {
  try {
    // Get a media stream ID for the target tab
    // NOTE: getMediaStreamId is callback-based (no Promise version in MV3)
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tab.id },
        (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        }
      );
    });

    // Ensure the offscreen document exists (reuse if already open)
    await ensureOffscreenDocument();

    // Send the stream ID to offscreen.js to start capture and PiP
    await chrome.runtime.sendMessage({
      type: "START_MIRROR_PIP",
      streamId,
      tabId: tab.id,
    });

    pipState = { active: true, mode: "mirror", tabId: tab.id };
    sendResponse({ success: true, mode: "mirror" });
  } catch (err) {
    console.error("[FloatTab SW] startMirrorMode error:", err);
    sendResponse({ success: false, error: err.message });
  }
}
