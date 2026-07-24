// Set to true for verbose console logging during development.
const KF_DEBUG = false;
const dbg = (...args) => { if (KF_DEBUG) console.log(...args); };

let audioContext = null;
let workletNode = null;
let sourceNode = null;
let mediaStream = null;
let currentMode = "stft";
let captureReady = false;
let capturedTabId = null;

chrome.runtime.onMessage.addListener((message, sender) => {
  dbg("[OFFSCREEN] received message:", message.type, "from:", sender.url || sender.id || "unknown");
  if (sender.tab) return;

  switch (message.type) {
    case "STREAM_READY":
      dbg("[OFFSCREEN] STREAM_READY received, mode:", message.mode);
      capturedTabId = message.tabId != null ? message.tabId : null;
      startCapture(message.streamId, message.mode || "stft");
      break;
    case "START_VIA_DISPLAY_MEDIA":
      dbg("[OFFSCREEN] START_VIA_DISPLAY_MEDIA received, mode:", message.mode);
      capturedTabId = message.tabId != null ? message.tabId : null;
      startCaptureViaDisplayMedia(message.mode || "stft");
      break;
    case "STOP_CAPTURE":
      dbg("[OFFSCREEN] STOP_CAPTURE received");
      stopCapture();
      break;
    case "SET_MIX":
      if (workletNode) {
        workletNode.port.postMessage({ type: "SET_MIX", value: message.value });
      }
      break;
    case "SET_MODE":
      switchMode(message.value);
      break;
  }
});

// Set up the AudioContext + worklet from a MediaStream that's already been
// acquired. Used by both the tabCapture path (Chrome-friendly, no picker) and
// the getDisplayMedia path (cross-browser, shows the system picker). Caller is
// responsible for cleanupAudio() before invoking.
async function startCaptureFromMediaStream(stream, initialMode) {
  mediaStream = stream;

  audioContext = new AudioContext();
  // Ensure context is running (Brave may start it suspended)
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const wasmUrl = chrome.runtime.getURL("wasm/build/vocal_remove.wasm");
  const wasmResponse = await fetch(wasmUrl);
  const wasmBytes = await wasmResponse.arrayBuffer();
  const wasmModule = await WebAssembly.compile(wasmBytes);

  const workletUrl = chrome.runtime.getURL("worklet-processor.js");
  await audioContext.audioWorklet.addModule(workletUrl);

  workletNode = new AudioWorkletNode(
    audioContext,
    "vocal-remove-processor",
    {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        wasmModule: wasmModule,
        sampleRate: audioContext.sampleRate,
        // Pass the mode in so the worklet applies the correct STFT depth during
        // its async WASM init — the SET_MODE postMessage below can otherwise
        // race ahead of (or behind) init and leave Deep at depth 0.
        mode: initialMode,
      },
    }
  );

  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // Audio graph: source → worklet → destination
  sourceNode.connect(workletNode);
  workletNode.connect(audioContext.destination);

  captureReady = true;
  dbg(`[OFFSCREEN] capture started, sample rate: ${audioContext.sampleRate}, mode "${initialMode}"`);

  switchMode(initialMode);
}

async function startCapture(streamId, initialMode) {
  dbg(`[OFFSCREEN] startCapture called, mode=${initialMode}, streamId=${streamId}`);
  try {
    cleanupAudio();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });
    await startCaptureFromMediaStream(stream, initialMode);
  } catch (err) {
    console.error("[OFFSCREEN] failed to start capture", err);
  }
}

// Cross-browser capture path: instead of tabCapture's getMediaStreamId
// (which Brave rejects when triggered from a side-panel button click),
// invoke the Web standard getDisplayMedia. Brave/Chrome/Edge all show a
// "Choose what to share" picker; the user selects the tab and checks
// "Share audio".
async function startCaptureViaDisplayMedia(initialMode) {
  dbg(`[OFFSCREEN] startCaptureViaDisplayMedia called, mode=${initialMode}`);
  try {
    cleanupAudio();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // suppressLocalAudioPlayback mutes the captured tab in the user's
      // speakers — without this, getDisplayMedia is just a tap and the
      // original (with vocals) keeps playing alongside our processed output.
      // Constraint supported in Chrome/Brave 109+.
      audio: { suppressLocalAudioPlayback: true },
      video: true, // required by spec; we drop it immediately
    });
    // Drop the video track — we only need audio
    stream.getVideoTracks().forEach((t) => {
      try { t.stop(); } catch {}
    });
    if (stream.getAudioTracks().length === 0) {
      console.warn("[OFFSCREEN] getDisplayMedia returned no audio track — user didn't check 'Share audio'");
      stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      chrome.runtime.sendMessage({ type: "DISPLAY_MEDIA_FAILED" }).catch(() => {});
      return;
    }
    await startCaptureFromMediaStream(stream, initialMode);
  } catch (err) {
    // Includes the user cancelling the picker — tell the SW so it rolls back
    // the capture state it set optimistically before showing the dialog.
    console.error("[OFFSCREEN] startCaptureViaDisplayMedia failed:", err && err.message);
    chrome.runtime.sendMessage({ type: "DISPLAY_MEDIA_FAILED" }).catch(() => {});
  }
}

function switchMode(mode) {
  dbg(`Karafilt: switchMode "${currentMode}" → "${mode}" (captureReady=${captureReady})`);
  currentMode = mode;
  if (!workletNode) return;
  if (mode === "basic") {
    workletNode.port.postMessage({ type: "SET_MODE", value: "basic" });
  } else if (mode === "stft_deep") {
    // Spectral Deep: STFT with a relaxed centerness mask (catches backing vocals).
    workletNode.port.postMessage({ type: "SET_MODE", value: "stft_deep" });
  } else {
    workletNode.port.postMessage({ type: "SET_MODE", value: "stft" });
  }
}

function cleanupAudio() {
  captureReady = false;
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (audioContext) { audioContext.close(); audioContext = null; }
}

function stopCapture() {
  dbg("Karafilt: stopCapture called");
  cleanupAudio();
  currentMode = "stft";
}
