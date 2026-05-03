/**
 * popup.js — FloatTab Popup Controller
 *
 * KEY ARCHITECTURE NOTE (first-click fix):
 * documentPictureInPicture.requestWindow() requires a user gesture. Routing
 * through the service worker via sendMessage breaks the gesture chain because
 * the SW does multiple async awaits before the message reaches content.js.
 *
 * Fix: For interactive mode, popup.js calls chrome.scripting.executeScript()
 * directly. Chrome propagates the user activation INTO the injected function,
 * so requestWindow() inside content.js receives a valid gesture every time.
 *
 * The service worker is still used for:
 *   - Header/embeddability checks (cached, returned synchronously)
 *   - Mirror mode (tab capture, offscreen document)
 *   - State management
 */

"use strict";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const pipBtn    = document.getElementById("pip-btn");
const btnLabel  = document.getElementById("btn-label");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

// ---------------------------------------------------------------------------
// UI state enum
// ---------------------------------------------------------------------------

const UI_STATE = {
  INACTIVE:    "inactive",
  INTERACTIVE: "interactive",
  MIRROR:      "mirror",
  RESTRICTED:  "restricted",
  UNSUPPORTED: "unsupported",
  ERROR:       "error",
  DRM:         "drm",
};

// ---------------------------------------------------------------------------
// Render UI based on state
// ---------------------------------------------------------------------------

function renderState(state, extraMsg) {
  pipBtn.className = "pip-btn";
  statusDot.className = "status-dot";

  switch (state) {
    case UI_STATE.INACTIVE:
      pipBtn.classList.add("inactive");
      btnLabel.textContent = "Float This Tab";
      statusDot.classList.add("inactive");
      statusText.innerHTML = "Inactive — click to open a floating window";
      pipBtn.disabled = false;
      setButtonIcon("float");
      break;

    case UI_STATE.INTERACTIVE:
      pipBtn.classList.add("active");
      btnLabel.textContent = "Close Float";
      statusDot.classList.add("interactive");
      statusText.innerHTML = "<strong>Interactive Mode</strong> — fully interactive window";
      pipBtn.disabled = false;
      setButtonIcon("close");
      break;

    case UI_STATE.MIRROR:
      pipBtn.classList.add("active");
      btnLabel.textContent = "Close Float";
      statusDot.classList.add("mirror");
      statusText.innerHTML = "<strong>View Only Mode</strong> — this site blocks embedding";
      pipBtn.disabled = false;
      setButtonIcon("close");
      break;

    case UI_STATE.RESTRICTED:
      pipBtn.classList.add("disabled");
      btnLabel.textContent = "Cannot Float This Page";
      statusDot.classList.add("error");
      statusText.innerHTML = "Chrome and system pages cannot be floated";
      pipBtn.disabled = true;
      break;

    case UI_STATE.UNSUPPORTED:
      pipBtn.classList.add("disabled");
      btnLabel.textContent = "Update Chrome";
      statusDot.classList.add("error");
      statusText.innerHTML =
        "Your Chrome version does not support interactive PiP. Update to Chrome 116+.";
      pipBtn.disabled = true;
      break;

    case UI_STATE.DRM:
      pipBtn.classList.add("disabled");
      btnLabel.textContent = "DRM Protected";
      statusDot.classList.add("error");
      statusText.innerHTML =
        "This site uses DRM protection. Screen capture is blocked.";
      pipBtn.disabled = true;
      break;

    case UI_STATE.ERROR:
      pipBtn.classList.add("inactive");
      btnLabel.textContent = "Float This Tab";
      statusDot.classList.add("error");
      statusText.innerHTML = extraMsg
        ? `Error: ${extraMsg}`
        : "Something went wrong — try again";
      pipBtn.disabled = false;
      setButtonIcon("float");
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Button icon swap
// ---------------------------------------------------------------------------

function setButtonIcon(type) {
  const icon = document.getElementById("btn-icon");
  if (type === "close") {
    icon.innerHTML = `
      <line x1="4" y1="4" x2="16" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <line x1="16" y1="4" x2="4" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    `;
  } else {
    icon.innerHTML = `
      <rect x="1" y="4" width="12" height="10" rx="2" fill="currentColor" fill-opacity="0.9"/>
      <rect x="9" y="9" width="10" height="8" rx="2" fill="currentColor" fill-opacity="0.5" stroke="currentColor" stroke-width="0.8"/>
    `;
  }
}

// ---------------------------------------------------------------------------
// Initialization — run when popup opens
// ---------------------------------------------------------------------------

async function initialize() {
  // Check Document PiP API support (Chrome 116+)
  if (!("documentPictureInPicture" in window)) {
    renderState(UI_STATE.UNSUPPORTED);
    return;
  }

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    renderState(UI_STATE.ERROR, "Could not query the active tab");
    return;
  }

  if (!tab) {
    renderState(UI_STATE.ERROR, "No active tab found");
    return;
  }

  const url = tab.url || "";
  if (isRestrictedUrl(url)) {
    renderState(UI_STATE.RESTRICTED);
    return;
  }

  // Query current PiP state from the service worker
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_PIP_STATE" });
    if (response && response.pipState && response.pipState.active) {
      renderState(
        response.pipState.mode === "interactive"
          ? UI_STATE.INTERACTIVE
          : UI_STATE.MIRROR
      );
    } else {
      renderState(UI_STATE.INACTIVE);
    }
  } catch (_) {
    renderState(UI_STATE.INACTIVE);
  }
}

// ---------------------------------------------------------------------------
// Restricted URL check (mirrors service_worker.js)
// ---------------------------------------------------------------------------

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
// Button click handler
// ---------------------------------------------------------------------------

pipBtn.addEventListener("click", async () => {
  if (pipBtn.disabled) return;

  const isActive = pipBtn.classList.contains("active");

  if (isActive) {
    // ---- CLOSE ----
    pipBtn.disabled = true;
    btnLabel.textContent = "Closing…";

    try {
      const response = await chrome.runtime.sendMessage({ type: "CLOSE_PIP" });
      renderState(response && response.success ? UI_STATE.INACTIVE : UI_STATE.ERROR, response?.error);
    } catch (err) {
      renderState(UI_STATE.ERROR, err.message);
    }
    return;
  }

  // ---- OPEN ----
  pipBtn.disabled = true;
  btnLabel.textContent = "Opening…";
  statusDot.className = "status-dot inactive";
  statusText.innerHTML = "Opening Picture-in-Picture window…";

  try {
    // Step 1: Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      renderState(UI_STATE.ERROR, "No active tab");
      return;
    }

    if (isRestrictedUrl(tab.url || "")) {
      renderState(UI_STATE.RESTRICTED);
      return;
    }

    // Step 2: Ask SW if the site is embeddable (uses cached headers — fast, no nav needed)
    let embeddable = true;
    try {
      const check = await chrome.runtime.sendMessage({
        type: "CHECK_EMBEDDABLE",
        tabId: tab.id,
        url: tab.url,
      });
      if (check && typeof check.embeddable === "boolean") {
        embeddable = check.embeddable;
      }
    } catch (_) {
      // SW not running yet; optimistically assume embeddable
    }

    if (embeddable) {
      // ---------------------------------------------------------------
      // INTERACTIVE MODE — use executeScript to preserve user gesture.
      //
      // chrome.scripting.executeScript() propagates the user activation
      // from this popup click INTO the injected function's execution
      // context, so documentPictureInPicture.requestWindow() always
      // receives a valid gesture on the FIRST click.
      // ---------------------------------------------------------------

      // First ensure content.js is injected (idempotent due to guard flag)
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/content.js"],
      });

      // Now call the exposed global directly inside the page.
      // This is the gesture-safe path.
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // __floatTabOpen is exposed by content.js
          if (typeof window.__floatTabOpen === "function") {
            return window.__floatTabOpen();
          }
          return { success: false, error: "content_not_ready" };
        },
      });

      // result is the Promise value returned by openDocumentPiP()
      // executeScript awaits Promises returned from injected functions
      if (!result || !result.success) {
        const errCode = result?.error || "unknown";

        if (errCode === "DOC_PIP_UNSUPPORTED") {
          renderState(UI_STATE.UNSUPPORTED);
          return;
        }

        // Interactive mode failed — fall back to mirror via SW
        const mirrorResp = await chrome.runtime.sendMessage({
          type: "OPEN_MIRROR_PIP",
          tabId: tab.id,
        });

        if (mirrorResp && mirrorResp.success) {
          renderState(UI_STATE.MIRROR);
        } else {
          renderState(UI_STATE.ERROR, mirrorResp?.error || errCode);
        }
        return;
      }

      // Notify SW to update its state
      await chrome.runtime.sendMessage({
        type: "SET_PIP_STATE",
        mode: "interactive",
        tabId: tab.id,
      });

      renderState(UI_STATE.INTERACTIVE);

    } else {
      // ---------------------------------------------------------------
      // MIRROR MODE — routed through service worker
      // ---------------------------------------------------------------
      const mirrorResp = await chrome.runtime.sendMessage({
        type: "OPEN_MIRROR_PIP",
        tabId: tab.id,
      });

      if (mirrorResp && mirrorResp.success) {
        renderState(UI_STATE.MIRROR);
      } else {
        renderState(UI_STATE.ERROR, mirrorResp?.error);
      }
    }

  } catch (err) {
    renderState(UI_STATE.ERROR, err.message);
  }
});

// ---------------------------------------------------------------------------
// Listen for state changes pushed from service worker / content script
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "PIP_CLOSED_BY_USER":
    case "MIRROR_PIP_ENDED":
      renderState(UI_STATE.INACTIVE);
      break;
    case "MIRROR_PIP_DRM_DETECTED":
      renderState(UI_STATE.DRM);
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

initialize();
