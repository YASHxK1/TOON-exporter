"use strict";

const pipBtn = document.getElementById("pip-btn");
const btnLabel = document.getElementById("btn-label");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const globalBadge = document.getElementById("global-pip-badge");

const UI_STATE = {
  INACTIVE: "inactive",
  INTERACTIVE: "interactive",
  MIRROR: "mirror",
  RESTRICTED: "restricted",
  UNSUPPORTED: "unsupported",
  ERROR: "error",
  DRM: "drm",
};

function renderState(state, extraMsg) {
  pipBtn.className = "pip-btn";
  statusDot.className = "status-dot";

  switch (state) {
    case UI_STATE.INACTIVE:
      pipBtn.classList.add("inactive");
      btnLabel.textContent = "Float This Tab";
      statusDot.classList.add("inactive");
      statusText.innerHTML = "Inactive - click to open a floating window";
      pipBtn.disabled = false;
      setButtonIcon("float");
      break;

    case UI_STATE.INTERACTIVE:
      pipBtn.classList.add("active");
      btnLabel.textContent = "Close Float";
      statusDot.classList.add("interactive");
      statusText.innerHTML = "<strong>Interactive Mode</strong> - fully interactive window";
      pipBtn.disabled = false;
      setButtonIcon("close");
      break;

    case UI_STATE.MIRROR:
      pipBtn.classList.add("active");
      btnLabel.textContent = "Close Float";
      statusDot.classList.add("mirror");
      statusText.innerHTML = "<strong>View Only Mode</strong> - this site blocks embedding";
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
        : "Something went wrong - try again";
      pipBtn.disabled = false;
      setButtonIcon("float");
      break;

    default:
      break;
  }
}

async function updateGlobalBadge() {
  if (!globalBadge) return;

  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_ALL_PIP_COUNT" });
    const count = resp?.count ?? 0;
    if (count > 0) {
      globalBadge.textContent = `${count} tab${count === 1 ? "" : "s"} floating`;
      globalBadge.style.display = "inline-flex";
    } else {
      globalBadge.style.display = "none";
    }
  } catch (_) {
    globalBadge.style.display = "none";
  }
}

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

async function initialize() {
  if (!("documentPictureInPicture" in window)) {
    renderState(UI_STATE.UNSUPPORTED);
    return;
  }

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {
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
    await updateGlobalBadge();
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_PIP_STATE",
      tabId: tab.id,
    });

    if (response?.pipState?.active) {
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

  await updateGlobalBadge();
}

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

function canUseTabHostedMirror(url) {
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

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/content.js"],
  });
}

async function openMirrorMode(tab) {
  await ensureContentScript(tab.id);

  if (canUseTabHostedMirror(tab.url || "")) {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
        consumerTabId: tab.id,
      });

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [streamId],
        func: (capturedStreamId) => {
          if (typeof window.__floatTabOpenMirror === "function") {
            return window.__floatTabOpenMirror(capturedStreamId);
          }
          return { success: false, error: "content_not_ready" };
        },
      });

      if (result?.success) {
        await chrome.runtime.sendMessage({
          type: "SET_PIP_STATE",
          mode: "mirror",
          host: "tab",
          tabId: tab.id,
        });

        return { success: true, mode: "mirror", host: "tab" };
      }

      throw new Error(result?.error || "unknown");
    } catch (err) {
      console.warn("[FloatTab Popup] Tab-hosted mirror failed, falling back:", err);
    }
  }

  return chrome.runtime.sendMessage({
    type: "OPEN_MIRROR_PIP",
    tabId: tab.id,
  });
}

pipBtn.addEventListener("click", async () => {
  if (pipBtn.disabled) return;

  const isActive = pipBtn.classList.contains("active");

  if (isActive) {
    pipBtn.disabled = true;
    btnLabel.textContent = "Closing...";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    try {
      const response = await chrome.runtime.sendMessage({
        type: "CLOSE_PIP",
        tabId: tab.id,
      });
      renderState(
        response?.success ? UI_STATE.INACTIVE : UI_STATE.ERROR,
        response?.error
      );
    } catch (err) {
      renderState(UI_STATE.ERROR, err.message);
    }

    await updateGlobalBadge();
    return;
  }

  pipBtn.disabled = true;
  btnLabel.textContent = "Opening...";
  statusDot.className = "status-dot inactive";
  statusText.innerHTML = "Opening Picture-in-Picture window...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      renderState(UI_STATE.ERROR, "No active tab");
      return;
    }

    if (isRestrictedUrl(tab.url || "")) {
      renderState(UI_STATE.RESTRICTED);
      return;
    }

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
      // Optimistically assume embeddable if the service worker is cold.
    }

    if (embeddable) {
      await ensureContentScript(tab.id);

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          if (typeof window.__floatTabOpen === "function") {
            return window.__floatTabOpen();
          }
          return { success: false, error: "content_not_ready" };
        },
      });

      if (!result || !result.success) {
        const errCode = result?.error || "unknown";

        if (errCode === "DOC_PIP_UNSUPPORTED") {
          renderState(UI_STATE.UNSUPPORTED);
          return;
        }

        const mirrorResp = await openMirrorMode(tab);
        if (mirrorResp?.success) {
          renderState(UI_STATE.MIRROR);
        } else {
          renderState(UI_STATE.ERROR, mirrorResp?.error || errCode);
        }
        await updateGlobalBadge();
        return;
      }

      await chrome.runtime.sendMessage({
        type: "SET_PIP_STATE",
        mode: "interactive",
        host: "tab",
        tabId: tab.id,
      });

      renderState(UI_STATE.INTERACTIVE);
    } else {
      const mirrorResp = await openMirrorMode(tab);

      if (mirrorResp?.success) {
        renderState(UI_STATE.MIRROR);
      } else {
        renderState(UI_STATE.ERROR, mirrorResp?.error);
      }
    }

    await updateGlobalBadge();
  } catch (err) {
    renderState(UI_STATE.ERROR, err.message);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "PIP_CLOSED_BY_USER":
    case "MIRROR_PIP_ENDED":
      void initialize();
      void updateGlobalBadge();
      break;
    case "MIRROR_PIP_DRM_DETECTED":
      if (message.tabId === undefined) {
        break;
      }

      void (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === message.tabId) {
          renderState(UI_STATE.DRM);
        }
      })();
      break;
    default:
      break;
  }
});

initialize();
