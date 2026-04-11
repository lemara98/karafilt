let offscreenReady = false;
let currentMode = "stft";
let capturedTabId = null;
let capturedTabUrl = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages from extension pages (popup), not from offscreen doc
  if (sender.url && sender.url.includes("offscreen.html")) return;

  console.log("[SW] received message:", message.type, "from:", sender.url || "unknown");

  switch (message.type) {
    case "START_CAPTURE":
      if (message.mode) currentMode = message.mode;
      console.log("[SW] START_CAPTURE mode:", currentMode, "tabId:", message.tabId);
      handleStartCapture(message.tabId, message.aiModel).then(sendResponse);
      return true; // async response

    case "STOP_CAPTURE":
      console.log("[SW] STOP_CAPTURE received, forwarding to offscreen");
      capturedTabId = null;
      capturedTabUrl = null;
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      break;

    case "SET_MIX":
      chrome.runtime.sendMessage({ type: "SET_MIX", value: message.value });
      break;

    case "SET_MODE":
      currentMode = message.value;
      chrome.runtime.sendMessage({ type: "SET_MODE", value: message.value });
      break;

    case "SET_AI_MODEL":
      chrome.runtime.sendMessage({ type: "SET_AI_MODEL", value: message.value });
      break;

    case "GET_AI_MODELS":
      ensureOffscreenDocument().then(() => {
        chrome.runtime.sendMessage({ type: "GET_AI_MODELS" }, sendResponse);
      });
      return true; // async response

    case "GET_STATE":
      sendResponse({ isActive: capturedTabId !== null });
      return false;
  }
});

// Stop capture when the captured tab navigates to a different page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === capturedTabId && changeInfo.url) {
    // Compare only origin + pathname to ignore query/hash changes (e.g. YouTube &t= params)
    try {
      const oldUrl = new URL(capturedTabUrl);
      const newUrl = new URL(changeInfo.url);
      if (oldUrl.origin + oldUrl.pathname !== newUrl.origin + newUrl.pathname) {
        console.log("Tab navigated away, stopping capture:", changeInfo.url);
        capturedTabId = null;
        capturedTabUrl = null;
        chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      } else {
        // Update stored URL but don't stop capture
        capturedTabUrl = changeInfo.url;
      }
    } catch (e) {
      // If URL parsing fails, stop capture to be safe
      capturedTabId = null;
      capturedTabUrl = null;
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    }
  }
});

// Stop capture when the captured tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === capturedTabId) {
    capturedTabId = null;
    capturedTabUrl = null;
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  }
});

async function handleStartCapture(tabId, aiModel) {
  try {
    // Stop any existing capture first
    if (capturedTabId !== null) {
      capturedTabId = null;
      capturedTabUrl = null;
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      // Give the offscreen document time to release the stream
      await new Promise(r => setTimeout(r, 300));
    }

    const tab = await chrome.tabs.get(tabId);
    console.log("[SW] tab URL:", tab.url);

    await ensureOffscreenDocument();
    console.log("[SW] offscreen document ready");

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });
    console.log("[SW] got stream ID:", streamId);

    // Send stream ID along with current mode so it's applied after capture starts
    capturedTabId = tabId;
    capturedTabUrl = tab.url;

    console.log("[SW] sending STREAM_READY, mode:", currentMode, "aiModel:", aiModel);
    chrome.runtime.sendMessage({
      type: "STREAM_READY",
      streamId: streamId,
      mode: currentMode,
      aiModel: aiModel,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to start capture:", err);
    return { success: false, error: err.message };
  }
}

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  // If a creation is already in progress, wait for it
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  // Check if one already exists (getContexts may not exist in all browsers)
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length > 0) {
      offscreenReady = true;
      return;
    }
  }

  // Try to create — if it already exists, catch and ignore
  try {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture tab audio for real-time vocal removal processing",
    });
    await creatingOffscreen;
  } catch (e) {
    if (!e.message.includes("single offscreen document")) {
      throw e;
    }
    // Already exists — that's fine
  }

  offscreenReady = true;
  creatingOffscreen = null;
}
