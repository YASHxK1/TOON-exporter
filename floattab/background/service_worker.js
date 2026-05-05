/**
 * service_worker.js — FloatTab Central Orchestrator (v2.0)
 *
 * Responsibilities:
 * - Listen for OPEN_PIP / CLOSE_PIP messages from popup.js
 * - Check if the active tab's URL is embeddable (no X-Frame-Options / restrictive CSP)
 * - Route to Mode A (interactive iframe via content.js) or Mode B (mirror mode)
 * - Prefer tab-hosted Document PiP mirror mode for secure origins
 * - Fall back to the shared offscreen document for insecure-origin mirror tabs
 * - Maintain pip state PER TAB via pipRegistry (supports unlimited concurrent PiP windows)
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * pipRegistry holds the current PiP status for EVERY floated tab independently.
 * Key: tabId (number)
 * Value: { mode: 'interactive'|'mirror', host: 'tab'|'offscreen' }
 *
 * v2.0 replaces the single `pipState` object with this Map so that any number
 * of tabs can be floated simultaneously.
 *
 * @type {Map<number, { mode: 'interactive'|'mirror', host: 'tab'|'offscreen' }>}
 */
const pipRegistry = new Map();

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

// Clean up when a tab is removed
chrome.tabs.onRemoved.addListener((tabId) => {
  headerCache.delete(tabId);

  // If the removed tab had an active PiP session, clean it up
  if (pipRegistry.has(tabId)) {
    const session = pipRegistry.get(tabId);

    // Stop only legacy offscreen mirror sessions explicitly.
    // Tab-hosted Document PiP windows close automatically with their opener tab.
    if (session.mode === "mirror" && session.host === "offscreen") {
      chrome.runtime
        .sendMessage({ type: "STOP_MIRROR_PIP", tabId })
        .catch(() => {});
    }

    pipRegistry.delete(tabId);
    updateBadge();

    // Close offscreen document if no mirror sessions remain
    maybeCloseOffscreen();
  }
});

// ---------------------------------------------------------------------------
// Badge management (shows count of currently-floating tabs on the toolbar icon)
// ---------------------------------------------------------------------------

function updateBadge() {
  const count = pipRegistry.size;
  if (count === 0) {
    chrome.action.setBadgeText({ text: "" });
  } else {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
  }
}

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

/**
 * Returns true when the tab itself can safely consume a tab-capture stream ID.
 * Chrome requires a secure origin for consumerTabId-based stream consumption.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isSecureMirrorConsumerUrl(url) {
  try {
    const parsed = new URL(url);

    if (parsed.protocol === "https:") {
      return true;
    }

    if (parsed.protocol !== "http:") {
      return false;
    }

    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]"
    );
  } catch (_) {
    return false;
  }
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
    justification: "Capture tab video streams for mirror-mode PiP windows",
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

/**
 * Closes the offscreen document only when no mirror-mode sessions remain.
 * Called after removing a tab from the registry.
 */
async function maybeCloseOffscreen() {
  const hasMirrorSessions = [...pipRegistry.values()].some(
    (s) => s.mode === "mirror" && s.host === "offscreen"
  );
  if (!hasMirrorSessions) {
    await closeOffscreenDocument();
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {

      // -----------------------------------------------------------------------
      // Popup queries embeddability synchronously from cached headers
      // -----------------------------------------------------------------------
      case "CHECK_EMBEDDABLE": {
        const embeddable = isEmbeddable(message.url || "", message.tabId);
        sendResponse({ embeddable });
        break;
      }

      // -----------------------------------------------------------------------
      // GET_PIP_STATE — now tab-scoped. Returns state for a specific tab.
      // -----------------------------------------------------------------------
      case "GET_PIP_STATE": {
        const tabId = message.tabId;
        const session = tabId !== undefined ? pipRegistry.get(tabId) : null;
        sendResponse({
          success: true,
          pipState: session
            ? { active: true, mode: session.mode, tabId }
            : { active: false, mode: null, tabId: tabId ?? null },
        });
        break;
      }

      // -----------------------------------------------------------------------
      // GET_ALL_PIP_COUNT — returns count of all active PiP sessions.
      // Used by popup to show the "N tabs floating" badge.
      // -----------------------------------------------------------------------
      case "GET_ALL_PIP_COUNT": {
        sendResponse({ success: true, count: pipRegistry.size });
        break;
      }

      // -----------------------------------------------------------------------
      // Popup uses executeScript for interactive mode; SW handles mirror only
      // -----------------------------------------------------------------------
      case "OPEN_MIRROR_PIP": {
        try {
          const tab = await chrome.tabs.get(message.tabId);
          await startMirrorMode(tab, sendResponse);
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Popup notifies SW of state after executeScript-based interactive open
      // -----------------------------------------------------------------------
      case "SET_PIP_STATE": {
        const { tabId, mode, host = "tab" } = message;
        pipRegistry.set(tabId, { mode, host });
        updateBadge();
        sendResponse({ success: true });
        break;
      }

      // -----------------------------------------------------------------------
      // CLOSE_PIP — now tab-scoped. Closes only the specified tab's PiP.
      // -----------------------------------------------------------------------
      case "CLOSE_PIP": {
        await handleClosePip(message.tabId, sendResponse);
        break;
      }

      // -----------------------------------------------------------------------
      // content.js signals iframe blocked — fall back to mirror
      // sender.tab.id identifies which tab triggered the fallback
      // -----------------------------------------------------------------------
      case "PIP_FALLBACK_TO_MIRROR":
        await handleFallbackToMirror(sender.tab, sendResponse);
        break;

      // -----------------------------------------------------------------------
      // content.js: user closed the Document PiP window natively
      // sender.tab.id tells us which tab's PiP was closed
      // -----------------------------------------------------------------------
      case "PIP_CLOSED_BY_USER": {
        const closedTabId = sender.tab?.id;
        if (closedTabId !== undefined) {
          pipRegistry.delete(closedTabId);
          updateBadge();
        }
        sendResponse({ success: true });
        break;
      }

      // -----------------------------------------------------------------------
      // offscreen.js: a mirror PiP window was closed or stream ended
      // message.tabId tells us which tab's session ended
      // -----------------------------------------------------------------------
      case "MIRROR_PIP_ENDED": {
        const endedTabId = message.tabId ?? sender.tab?.id;
        if (endedTabId !== undefined) {
          pipRegistry.delete(endedTabId);
          updateBadge();
        }
        await maybeCloseOffscreen();
        sendResponse({ success: true });
        break;
      }

      // -----------------------------------------------------------------------
      // offscreen.js: DRM protection detected on a specific mirror tab
      // -----------------------------------------------------------------------
      case "MIRROR_PIP_DRM_DETECTED": {
        if (!message.forwarded) {
          const drmTabId = message.tabId ?? sender.tab?.id;
          if (drmTabId !== undefined) {
            chrome.runtime
              .sendMessage({
                type: "MIRROR_PIP_DRM_DETECTED",
                tabId: drmTabId,
                forwarded: true,
              })
              .catch(() => {});
          }
        }
        // The popup for the affected tab will receive this and render DRM state.
        // No registry change needed here — popup handles its own UI.
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ success: false, error: "Unknown message type" });
    }
  })();

  return true; // Keep channel open for async sendResponse
});

// ---------------------------------------------------------------------------
// CLOSE_PIP handler — closes only the specified tab's PiP
// ---------------------------------------------------------------------------

async function handleClosePip(tabId, sendResponse) {
  try {
    const session = pipRegistry.get(tabId);

    if (!session) {
      // Nothing to close — respond as success
      sendResponse({ success: true });
      return;
    }

    if (session.host === "tab") {
      // Interactive mode and secure-origin mirror mode both live in content.js.
      try {
        await chrome.tabs.sendMessage(tabId, { type: "CLOSE_TAB_PIP" });
      } catch (_) {
        // Tab may have navigated — ignore
      }
    } else if (session.mode === "mirror") {
      // Tell offscreen.js to stop this specific tab's capture
      try {
        await chrome.runtime.sendMessage({ type: "STOP_MIRROR_PIP", tabId });
      } catch (_) {}
    }

    pipRegistry.delete(tabId);
    updateBadge();
    await maybeCloseOffscreen();

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

  try {
    if (isSecureMirrorConsumerUrl(tab.url || "")) {
      const streamId = await getMirrorStreamId(tab.id, tab.id);

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "START_MIRROR_DOC_PIP",
        streamId,
        reuseExistingWindow: true,
      });

      if (!response?.success) {
        throw new Error(response?.error || "Mirror fallback failed");
      }

      pipRegistry.set(tab.id, { mode: "mirror", host: "tab" });
      updateBadge();

      sendResponse({ success: true, host: "tab" });
      return;
    }

    await startMirrorMode(tab, sendResponse);
  } catch (err) {
    console.error("[FloatTab SW] handleFallbackToMirror error:", err);
    sendResponse({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Mirror mode startup — per-tab
// ---------------------------------------------------------------------------

async function getMirrorStreamId(targetTabId, consumerTabId) {
  const options = { targetTabId };
  if (consumerTabId !== undefined) {
    options.consumerTabId = consumerTabId;
  }

  return chrome.tabCapture.getMediaStreamId(options);
}

async function startMirrorMode(tab, sendResponse) {
  try {
    // ── Prefer tab-hosted Document PiP for ALL origins when possible ──────────
    // Document PiP windows are fully independent per-tab: each content script
    // manages its own window, so any number of tabs can be floated concurrently.
    //
    // We fall back to the shared offscreen document only for insecure origins
    // (http:// non-localhost) where the tab itself cannot consume the stream.
    // NOTE: native video PiP (offscreen path) is subject to the browser's
    // "one video PiP per browsing context" rule, so concurrent offscreen
    // sessions on the same device will replace each other. Users on insecure
    // origins should upgrade to HTTPS for full multi-tab support.

    if (isSecureMirrorConsumerUrl(tab.url || "")) {
      // Secure origin → use Document PiP inside the tab (fully concurrent)
      const streamId = await getMirrorStreamId(tab.id, tab.id);

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "START_MIRROR_DOC_PIP",
        streamId,
        reuseExistingWindow: false,
      });

      if (!response?.success) {
        throw new Error(response?.error || "Mirror Doc PiP failed");
      }

      pipRegistry.set(tab.id, { mode: "mirror", host: "tab" });
      updateBadge();

      sendResponse({ success: true, mode: "mirror", host: "tab" });
      return;
    }

    // ── Insecure origin fallback: shared offscreen document ───────────────────
    // Only one native video PiP can be open at a time on insecure origins.
    // We still allow it so the feature works at all on http:// pages, but
    // warn the user that it will replace any existing offscreen mirror.
    const streamId = await getMirrorStreamId(tab.id);

    // Ensure the shared offscreen document exists (reuse if already open)
    await ensureOffscreenDocument();

    // Send the stream ID and tabId to offscreen.js so it can manage per-tab sessions.
    // stopMirrorPiP for the previous tab (if any) is handled inside offscreen.js
    // via the sessions Map, so each tab still gets its own tracked session.
    await chrome.runtime.sendMessage({
      type: "START_MIRROR_PIP",
      streamId,
      tabId: tab.id,
    });

    // Register this tab in the registry
    pipRegistry.set(tab.id, { mode: "mirror", host: "offscreen" });
    updateBadge();

    sendResponse({ success: true, mode: "mirror", host: "offscreen" });
  } catch (err) {
    console.error("[FloatTab SW] startMirrorMode error:", err);
    sendResponse({ success: false, error: err.message });
  }
}
