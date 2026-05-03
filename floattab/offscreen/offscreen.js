/**
 * offscreen.js — FloatTab Mirror Mode Handler
 *
 * Runs in the hidden offscreen document (MV3).
 * Responsibilities:
 * - Listen for START_MIRROR_PIP message with a tab capture streamId
 * - Call getUserMedia with chromeMediaSource:"tab" to acquire the video stream
 * - Attach the stream to a <video> element and play it
 * - Call video.requestPictureInPicture() to open native video PiP
 * - Listen for STOP_MIRROR_PIP to tear down the stream
 * - Notify the service worker when the stream ends unexpectedly
 */

"use strict";

/** Reference to the active MediaStream (if any) */
let activeStream = null;

/** Reference to the video element */
const video = document.getElementById("floattab-capture-video");

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "START_MIRROR_PIP") {
    startMirrorPiP(message.streamId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error("[FloatTab Offscreen] startMirrorPiP error:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep channel open for async response
  }

  if (message.type === "STOP_MIRROR_PIP") {
    stopMirrorPiP();
    sendResponse({ success: true });
    return false;
  }
});

// ---------------------------------------------------------------------------
// Start mirror PiP
// ---------------------------------------------------------------------------

/**
 * Acquires the tab capture stream and opens native video PiP.
 * @param {string} streamId - The stream ID returned by chrome.tabCapture.getMediaStreamId
 */
async function startMirrorPiP(streamId) {
  // Stop any previous stream first
  stopMirrorPiP();

  // Acquire the tab's video stream using the provided streamId.
  // chromeMediaSource:"tab" is the Manifest V3 way to capture a tab's stream
  // using a pre-obtained stream ID from the service worker.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    audio: false, // v1.0: no audio routing (see PRD non-goals)
  });

  activeStream = stream;

  // Attach stream to the hidden video element
  video.srcObject = stream;
  video.muted = true;

  // We must play() the video before calling requestPictureInPicture()
  await video.play();

  // Open the native browser video PiP window.
  // requestPictureInPicture() requires a user gesture. In this case the gesture
  // chain is: popup button click → service worker message → offscreen message →
  // this call. Chrome preserves the user activation through this synchronous chain.
  await video.requestPictureInPicture();

  // Listen for the PiP window being closed by the user
  video.addEventListener("leavepictureinpicture", handlePiPClosed, { once: true });

  // Listen for the stream ending unexpectedly (e.g. tab closed, capture revoked)
  stream.getVideoTracks()[0].addEventListener("ended", () => {
    stopMirrorPiP();
    chrome.runtime
      .sendMessage({ type: "MIRROR_PIP_ENDED" })
      .catch(() => {});
  });

  // DRM detection: if the video readyState never advances past HAVE_NOTHING
  // after 3 seconds, the tab is likely DRM-protected (black screen).
  setTimeout(() => {
    if (video.readyState === HTMLMediaElement.HAVE_NOTHING && activeStream) {
      chrome.runtime
        .sendMessage({ type: "MIRROR_PIP_DRM_DETECTED" })
        .catch(() => {});
    }
  }, 3000);
}

// ---------------------------------------------------------------------------
// Stop / teardown
// ---------------------------------------------------------------------------

/**
 * Stops the active media stream and exits PiP if open.
 */
function stopMirrorPiP() {
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }

  video.srcObject = null;

  // Exit PiP if the document is currently in PiP mode
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// PiP close event
// ---------------------------------------------------------------------------

function handlePiPClosed() {
  stopMirrorPiP();
  chrome.runtime.sendMessage({ type: "MIRROR_PIP_ENDED" }).catch(() => {});
}
