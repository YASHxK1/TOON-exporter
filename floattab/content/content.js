(function () {
  "use strict";

  if (window.__floatTabInitialized) return;
  window.__floatTabInitialized = true;

  let pipWindow = null;
  let sessionMode = null;
  let fallbackTriggered = false;
  let suppressNextPagehideMessage = false;
  let mirrorSession = null;

  window.__floatTabOpen = () => openDocumentPiP();
  window.__floatTabOpenMirror = (streamId) => openMirrorPiP(streamId);
  window.__floatTabClose = () => {
    closeActivePiP({ notify: false });
    return { success: true };
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "INJECT_DOC_PIP") {
      openDocumentPiP()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.type === "START_MIRROR_DOC_PIP") {
      openMirrorPiP(message.streamId, {
        reuseExistingWindow: Boolean(message.reuseExistingWindow),
      })
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.type === "CLOSE_DOC_PIP" || message.type === "CLOSE_TAB_PIP") {
      closeActivePiP({ notify: false });
      sendResponse({ success: true });
      return false;
    }
  });

  async function openDocumentPiP() {
    if (!("documentPictureInPicture" in window)) {
      return {
        success: false,
        error: "DOC_PIP_UNSUPPORTED",
      };
    }

    fallbackTriggered = false;

    let nextWindow;
    try {
      nextWindow = await ensurePipWindow({ reuseExistingWindow: false });
    } catch (err) {
      return { success: false, error: `requestWindow failed: ${err.message}` };
    }

    sessionMode = "interactive";
    cleanupMirrorSession();

    const pipDoc = nextWindow.document;
    copyStylesheets(document, pipDoc);
    const body = resetPipDocument(pipDoc);

    const iframe = pipDoc.createElement("iframe");
    iframe.src = window.location.href;
    iframe.id = "floattab-iframe";
    iframe.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;border:none;display:block;background:#fff;";

    iframe.addEventListener("error", () => {
      void handleIframeError();
    });

    iframe.addEventListener("load", () => {
      if (sessionMode !== "interactive" || fallbackTriggered) {
        return;
      }

      try {
        const doc = iframe.contentDocument;
        if (!doc || doc.body === null) {
          void handleIframeError();
        }
      } catch (_) {
        // Cross-origin access throws here for healthy embeds; ignore it.
      }
    });

    body.appendChild(iframe);

    return { success: true, mode: "interactive" };
  }

  async function openMirrorPiP(streamId, options = {}) {
    if (!("documentPictureInPicture" in window)) {
      return {
        success: false,
        error: "DOC_PIP_UNSUPPORTED",
      };
    }

    const { reuseExistingWindow = false } = options;
    fallbackTriggered = false;

    let nextWindow;
    try {
      nextWindow = await ensurePipWindow({ reuseExistingWindow });
    } catch (err) {
      return { success: false, error: `requestWindow failed: ${err.message}` };
    }

    sessionMode = "mirror";
    cleanupMirrorSession();
    renderLoadingState("Starting view-only mode...");

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
          },
        },
        audio: false,
      });
    } catch (err) {
      closeActivePiP({ notify: false });
      return { success: false, error: err.message };
    }

    if (!pipWindow || pipWindow.closed || pipWindow !== nextWindow) {
      stream.getTracks().forEach((track) => track.stop());
      return {
        success: false,
        error: "Mirror window closed before capture could start",
      };
    }

    const body = resetPipDocument(nextWindow.document);
    const video = nextWindow.document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
    video.style.cssText =
      "width:100%;height:100%;display:block;object-fit:contain;background:#000;";
    video.srcObject = stream;
    body.appendChild(video);

    try {
      await video.play();
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop());
      closeActivePiP({ notify: false });
      return { success: false, error: err.message };
    }

    const track = stream.getVideoTracks()[0];
    const onTrackEnded = () => {
      if (sessionMode !== "mirror") {
        return;
      }

      chrome.runtime.sendMessage({ type: "MIRROR_PIP_ENDED" }).catch(() => {});
      closeActivePiP({ notify: false });
    };

    if (track) {
      track.addEventListener("ended", onTrackEnded, { once: true });
    }

    const drmTimer = setTimeout(() => {
      if (
        mirrorSession &&
        mirrorSession.video === video &&
        video.readyState === HTMLMediaElement.HAVE_NOTHING
      ) {
        chrome.runtime
          .sendMessage({ type: "MIRROR_PIP_DRM_DETECTED" })
          .catch(() => {});
      }
    }, 3000);

    mirrorSession = {
      stream,
      video,
      drmTimer,
      onTrackEnded,
    };

    return { success: true, mode: "mirror" };
  }

  async function ensurePipWindow(options = {}) {
    const { reuseExistingWindow = false } = options;

    if (!("documentPictureInPicture" in window)) {
      throw new Error("DOC_PIP_UNSUPPORTED");
    }

    if (pipWindow && pipWindow.closed) {
      pipWindow = null;
    }

    if (reuseExistingWindow && pipWindow && !pipWindow.closed) {
      primePipWindow(pipWindow);
      return pipWindow;
    }

    if (pipWindow && !pipWindow.closed) {
      suppressNextPagehideMessage = true;
      sessionMode = null;
      fallbackTriggered = false;
      cleanupMirrorSession();

      const previousWindow = pipWindow;
      pipWindow = null;
      previousWindow.close();
    }

    const nextWindow = await window.documentPictureInPicture.requestWindow({
      width: 854,
      height: 480,
    });

    pipWindow = nextWindow;
    primePipWindow(nextWindow);

    return nextWindow;
  }

  function primePipWindow(nextWindow) {
    const pipDoc = nextWindow.document;
    pipDoc.documentElement.style.cssText =
      "margin:0;padding:0;width:100%;height:100%;";
    pipDoc.body.style.cssText =
      "margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;position:relative;";

    if (nextWindow.__floatTabBound) {
      return;
    }

    nextWindow.__floatTabBound = true;
    nextWindow.addEventListener(
      "pagehide",
      () => {
        handlePipWindowPagehide(nextWindow);
      },
      { once: true }
    );
  }

  function handlePipWindowPagehide(closedWindow) {
    const shouldNotify = !suppressNextPagehideMessage;
    suppressNextPagehideMessage = false;

    cleanupMirrorSession();

    if (pipWindow === closedWindow) {
      pipWindow = null;
    }

    sessionMode = null;
    fallbackTriggered = false;

    if (shouldNotify) {
      chrome.runtime.sendMessage({ type: "PIP_CLOSED_BY_USER" }).catch(() => {});
    }
  }

  function resetPipDocument(pipDoc) {
    pipDoc.documentElement.style.cssText =
      "margin:0;padding:0;width:100%;height:100%;";
    pipDoc.body.style.cssText =
      "margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;position:relative;";
    pipDoc.body.replaceChildren();
    return pipDoc.body;
  }

  function renderLoadingState(message) {
    if (!pipWindow || pipWindow.closed) {
      return;
    }

    const body = resetPipDocument(pipWindow.document);
    const status = pipWindow.document.createElement("div");
    status.textContent = message;
    status.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;color:#e5e7eb;font:600 16px/1.4 system-ui,sans-serif;text-align:center;background:radial-gradient(circle at top, rgba(59,130,246,0.28), transparent 55%), #05070b;";
    body.appendChild(status);
  }

  async function handleIframeError() {
    if (sessionMode !== "interactive" || fallbackTriggered) {
      return;
    }

    fallbackTriggered = true;
    renderLoadingState("This site blocks embedding. Switching to view-only mode...");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "PIP_FALLBACK_TO_MIRROR",
      });

      if (!response?.success) {
        throw new Error(response?.error || "Mirror fallback failed");
      }

      if (response.host === "offscreen") {
        closeActivePiP({ notify: false });
      }
    } catch (err) {
      console.warn("[FloatTab] Mirror fallback failed:", err);
      closeActivePiP();
    }
  }

  function closeActivePiP(options = {}) {
    const { notify = true } = options;
    const currentWindow = pipWindow;

    if (!notify) {
      suppressNextPagehideMessage = true;
    }

    fallbackTriggered = false;
    sessionMode = null;
    cleanupMirrorSession();

    if (currentWindow && !currentWindow.closed) {
      pipWindow = null;
      currentWindow.close();
      return;
    }

    pipWindow = null;
    suppressNextPagehideMessage = false;

    if (notify) {
      chrome.runtime.sendMessage({ type: "PIP_CLOSED_BY_USER" }).catch(() => {});
    }
  }

  function cleanupMirrorSession(options = {}) {
    const { stopTracks = true } = options;

    if (!mirrorSession) {
      return;
    }

    const { stream, video, drmTimer, onTrackEnded } = mirrorSession;
    clearTimeout(drmTimer);

    const track = stream.getVideoTracks()[0];
    if (track && onTrackEnded) {
      track.removeEventListener("ended", onTrackEnded);
    }

    if (stopTracks) {
      stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
    }

    if (video) {
      video.srcObject = null;
      video.remove();
    }

    mirrorSession = null;
  }

  function copyStylesheets(sourceDoc, targetDoc) {
    const elements = [
      ...sourceDoc.querySelectorAll('link[rel="stylesheet"], style'),
    ];

    for (const el of elements) {
      try {
        const clone = targetDoc.importNode(el, true);
        targetDoc.head.appendChild(clone);
      } catch (err) {
        console.warn("[FloatTab] Could not copy stylesheet:", err);
      }
    }
  }
})();
