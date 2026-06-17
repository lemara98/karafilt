// Set to true for verbose console logging during development.
const KF_DEBUG = false;
const dbg = (...args) => { if (KF_DEBUG) console.log(...args); };

let audioContext = null;
let workletNode = null;
let sourceNode = null;
let mediaStream = null;
let ws = null;
let currentMode = "stft";
let currentAIModel = "htdemucs";
let captureReady = false;
// AI server address. Empty until the service worker pushes the user's
// configured Server URL from storage (offscreen docs can't read storage).
let serverUrl = "";
let apiKey = "";
let aiChunksSent = 0;

function sendAIStatus(status, detail) {
  chrome.runtime.sendMessage({ type: "AI_STATUS", status, detail });
}

// Server settings are pushed in from the service worker (offscreen
// docs can't access chrome.storage directly — only chrome.runtime).

// AI mode state. Chunk size kept at 5s because Demucs's hybrid transformer
// produces noticeably better separation with that much surrounding context;
// shorter chunks (we tried 2s) audibly degrade vocal isolation.
//
// Each received chunk carries ~(CHUNK-OVERLAP)=4s of fresh content and capture
// is real-time, so supply ≈ consumption with no slack. We therefore buffer a
// short LEAD before starting gapless playback: AI_PREBUFFER_CHUNKS chunks ≈ 8s
// of audio, ~4s of jitter slack so the output never underruns. While the lead
// fills we stay SILENT (no STFT preview) — the user waits for clean AI. Higher
// = smoother but a longer initial wait.
const AI_CHUNK_SECONDS = 5;
const AI_OVERLAP_SECONDS = 1;   // overlap between consecutive chunks
const AI_PREBUFFER_CHUNKS = 2;  // lead buffer before gapless playback starts
let aiRecordBuffers = [[], []];
let aiRecordedSamples = 0;
let aiOverlapBuffers = [null, null]; // stores tail of previous chunk for overlap
let aiPlaybackQueue = [];
let aiChunksReceived = 0;
// Gapless playback scheduler. Chunks are scheduled back-to-back on the
// AudioContext clock (not chained via onended) so jitter can't open gaps.
let aiStarted = false;             // gapless playback has begun (lead filled)
let aiNextStartTime = null;        // ctx-clock time the next chunk is scheduled at
let aiPlaybackStartCtxTime = null; // ctx time the first chunk began playing
let aiScheduledContentSeconds = 0; // total content scheduled (for the lag clamp)
let aiScheduledSources = [];       // live BufferSources, for stop/teardown
let aiBufferNode = null;
let aiGainNode = null;
let workletGainNode = null;  // controls worklet volume (fades out when AI plays)
let aiOutputGainNode = null; // controls AI playback volume

// ── AI playback-lag measurement ─────────────────────────────────────────────
// Capture runs in real time, so "captured seconds" tracks the video; "played
// seconds" is the cumulative AI-processed audio actually emitted. The gap is
// how far the AI audio lags the video — the side panel shifts the lyric
// highlight back by this so lyrics line up with what the user hears.
let aiCaptureStartCtxTime = null;     // ctx time of the first captured AI frame
let lastReportedLag = -1;             // dedupe AI_LAG sends

function resetAILagState() {
  aiCaptureStartCtxTime = null;
  lastReportedLag = -1;
}

function computeLagSeconds() {
  if (!audioContext || !aiStarted || aiCaptureStartCtxTime === null
      || aiPlaybackStartCtxTime === null) return 0;
  const capturedSeconds = audioContext.currentTime - aiCaptureStartCtxTime;
  // Content actually emitted = time elapsed since playback began, capped at
  // what's been scheduled — so a (rare) underrun gap correctly grows the lag.
  const playedSeconds = Math.min(
    audioContext.currentTime - aiPlaybackStartCtxTime,
    aiScheduledContentSeconds,
  );
  return Math.max(0, capturedSeconds - playedSeconds);
}

function reportLag() {
  const rounded = Math.round(computeLagSeconds() * 100) / 100;
  if (rounded === lastReportedLag) return;
  lastReportedLag = rounded;
  chrome.runtime.sendMessage({ type: "AI_LAG", lagSeconds: rounded });
}

// Reset lag tracking and tell the side panel the offset is back to 0 — used on
// every AI teardown path (mode change, stop, websocket close).
function emitZeroLag() {
  resetAILagState();
  chrome.runtime.sendMessage({ type: "AI_LAG", lagSeconds: 0 });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  dbg("[OFFSCREEN] received message:", message.type, "from:", sender.url || sender.id || "unknown");
  if (sender.tab) return;

  switch (message.type) {
    case "STREAM_READY":
      dbg("[OFFSCREEN] STREAM_READY received, mode:", message.mode, "aiModel:", message.aiModel);
      if (message.aiModel) currentAIModel = message.aiModel;
      if (message.serverUrl) serverUrl = message.serverUrl;
      if (typeof message.apiKey === "string") apiKey = message.apiKey;
      startCapture(message.streamId, message.mode || "stft");
      break;
    case "START_VIA_DISPLAY_MEDIA":
      dbg("[OFFSCREEN] START_VIA_DISPLAY_MEDIA received, mode:", message.mode);
      if (message.aiModel) currentAIModel = message.aiModel;
      if (message.serverUrl) serverUrl = message.serverUrl;
      if (typeof message.apiKey === "string") apiKey = message.apiKey;
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
    case "SET_AI_MODEL":
      currentAIModel = message.value;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "set_model", value: currentAIModel }));
      }
      break;
    case "SET_SERVER_URL":
      serverUrl = message.value;
      break;
    case "SET_API_KEY":
      apiKey = message.value;
      break;
    case "GET_AI_MODELS":
      if (message.serverUrl) serverUrl = message.serverUrl;
      if (typeof message.apiKey === "string") apiKey = message.apiKey;
      fetchModelsFromServer().then(sendResponse);
      return true; // async response
  }
});

// Set up the AudioContext + worklet + AI tap from a MediaStream that's
// already been acquired. Used by both the tabCapture path (Chrome-friendly,
// no picker) and the getDisplayMedia path (cross-browser, shows the system
// picker). Caller is responsible for cleanupAudio() before invoking.
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
      },
    }
  );

  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // Gain nodes for crossfading between worklet output and AI output
  workletGainNode = audioContext.createGain();
  workletGainNode.gain.value = 1.0;
  aiOutputGainNode = audioContext.createGain();
  aiOutputGainNode.gain.value = 0.0;

  // Audio graph:
  //   source → worklet → workletGain → destination
  //   source → aiBufferNode → (silent, just for capturing PCM)
  //   AI playback → aiOutputGain → destination
  sourceNode.connect(workletNode);
  workletNode.connect(workletGainNode);
  workletGainNode.connect(audioContext.destination);
  aiOutputGainNode.connect(audioContext.destination);

  // AI capture tap (always connected, only records when in AI mode)
  aiBufferNode = audioContext.createScriptProcessor(4096, 2, 2);
  aiBufferNode.onaudioprocess = onAIAudioProcess;
  aiGainNode = audioContext.createGain();
  aiGainNode.gain.value = 0;
  sourceNode.connect(aiBufferNode);
  aiBufferNode.connect(aiGainNode);
  aiGainNode.connect(audioContext.destination);

  captureReady = true;
  dbg(`[OFFSCREEN] capture started, sample rate: ${audioContext.sampleRate}, about to switchMode("${initialMode}")`);

  switchMode(initialMode);
  dbg(`[OFFSCREEN] switchMode complete, ws=${ws ? ws.readyState : "null"}, currentMode=${currentMode}`);
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
// "Share audio". User gesture must be active in this document (we rely on
// the offscreen being created with reasons including DISPLAY_MEDIA, and on
// the side-panel button click that initiated this flow being recent
// enough to satisfy the transient-activation check).
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
      sendAIStatus("error", { reason: "no-audio-track" });
      return;
    }
    await startCaptureFromMediaStream(stream, initialMode);
  } catch (err) {
    console.error("[OFFSCREEN] startCaptureViaDisplayMedia failed:", err && err.message);
    sendAIStatus("error", { reason: err && err.name === "NotAllowedError" ? "user-cancelled" : "display-media-failed" });
  }
}

function isAIMode(mode) {
  return mode === "ai" || mode === "ai2";
}

function switchMode(mode) {
  const wasAI = isAIMode(currentMode);
  dbg(`Karafilt: switchMode "${currentMode}" → "${mode}" (captureReady=${captureReady})`);
  currentMode = mode;

  // Always keep the worklet running with STFT for audio output
  // (even in AI mode, STFT serves as preview until AI chunks arrive)
  if (workletNode) {
    if (mode === "basic") {
      workletNode.port.postMessage({ type: "SET_MODE", value: "basic" });
    } else {
      // "stft", "ai", and "ai2" all use STFT processing in the worklet
      workletNode.port.postMessage({ type: "SET_MODE", value: "stft" });
    }
  }

  if (isAIMode(mode) && captureReady) {
    // Wait SILENTLY for the AI lead buffer — no STFT preview while preparing.
    // (STFT only returns as a fallback if the connection actually fails.)
    if (workletGainNode) workletGainNode.gain.value = 0.0;
    if (aiOutputGainNode) aiOutputGainNode.gain.value = 0.0;
    sendAIStatus("connecting");
    openWebSocket();
    // Tell the server which AI mode to use
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_two_pass", value: mode === "ai2" }));
    }
  } else if (wasAI && !isAIMode(mode)) {
    closeWebSocket();
    sendAIStatus("idle");
    // Restore worklet to full volume
    if (workletGainNode) workletGainNode.gain.value = 1.0;
    if (aiOutputGainNode) aiOutputGainNode.gain.value = 0.0;
  }
}

function openWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  closeWebSocket();

  // No AI server configured (Settings → Server URL). Fall back to the audible
  // STFT preview so the user isn't left in silence; the UI explains how to
  // enable AI.
  if (!serverUrl) {
    if (workletGainNode) workletGainNode.gain.value = 1.0;
    sendAIStatus("no_server");
    return;
  }

  stopAIPlayback();
  aiRecordBuffers = [[], []];
  aiRecordedSamples = 0;
  aiOverlapBuffers = [null, null];
  aiPlaybackQueue = [];
  aiChunksReceived = 0;

  dbg(`Karafilt: connecting to backend at ${serverUrl}...`);
  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    // Malformed URL typed into settings — surface it instead of throwing.
    ws = null;
    sendAIStatus("error");
    return;
  }
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    dbg(`Karafilt: connected to backend (mode=${currentMode}, model=${currentAIModel}, captureReady=${captureReady})`);
    sendAIStatus("recording");
    // Authenticate if an API key is configured
    if (apiKey) {
      ws.send(JSON.stringify({ type: "auth", token: apiKey }));
    }
    // Tell the server which model and mode to use
    ws.send(JSON.stringify({ type: "set_model", value: currentAIModel }));
    ws.send(JSON.stringify({ type: "set_two_pass", value: currentMode === "ai2" }));
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") return;
    if (event.data.byteLength < 8) return;

    const view = new DataView(event.data);
    const sampleRate = view.getUint32(0, true);
    const numSamples = view.getUint32(4, true);
    const pcm = new Float32Array(event.data, 8);

    let left = new Float32Array(numSamples);
    let right = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      left[i] = pcm[i * 2];
      right[i] = pcm[i * 2 + 1];
    }

    // Crossfade with previous chunk's overlap tail to eliminate boundary artifacts
    const overlapSamples = Math.round(AI_OVERLAP_SECONDS * sampleRate);
    if (aiOverlapBuffers[0] && overlapSamples > 0) {
      const prevLeft = aiOverlapBuffers[0];
      const prevRight = aiOverlapBuffers[1];
      const fadeLen = Math.min(prevLeft.length, overlapSamples, numSamples);
      for (let i = 0; i < fadeLen; i++) {
        const t = i / fadeLen;  // 0 → 1
        left[i] = prevLeft[i] * (1 - t) + left[i] * t;
        right[i] = prevRight[i] * (1 - t) + right[i] * t;
      }
    }

    // Store the tail of this chunk for crossfading with the next one
    if (overlapSamples > 0 && numSamples > overlapSamples) {
      const tailStart = numSamples - overlapSamples;
      aiOverlapBuffers[0] = left.slice(tailStart);
      aiOverlapBuffers[1] = right.slice(tailStart);
      // Trim the chunk so the overlap region isn't played twice
      left = left.slice(0, tailStart);
      right = right.slice(0, tailStart);
    }

    aiPlaybackQueue.push({ left, right, sampleRate });
    aiChunksReceived++;
    dbg(`Received ${numSamples} processed samples from Demucs (chunk #${aiChunksReceived})`);

    // While the lead buffer fills we stay silent and show progress; once it's
    // full, scheduleReadyChunks() begins gapless playback and emits ai_active.
    if (!aiStarted && aiChunksReceived < AI_PREBUFFER_CHUNKS) {
      sendAIStatus("buffering", { received: aiChunksReceived, needed: AI_PREBUFFER_CHUNKS });
    }

    scheduleReadyChunks();
  };

  ws.onerror = (err) => {
    console.error("Karafilt: WebSocket error", err);
    sendAIStatus("error");
  };

  ws.onclose = (event) => {
    dbg("Karafilt: WebSocket closed, code:", event.code, "reason:", event.reason);
    // Unexpected close while in AI mode → stop AI playback and fall back to the
    // audible STFT preview (a genuine failure, distinct from buffering silence).
    if (isAIMode(currentMode) && workletGainNode) {
      stopAIPlayback();
      workletGainNode.gain.value = 1.0;
      if (aiOutputGainNode) aiOutputGainNode.gain.value = 0.0;
      sendAIStatus("fallback");
    }
    emitZeroLag();
  };
}

function closeWebSocket() {
  if (ws) {
    dbg("[OFFSCREEN] closeWebSocket called, ws.readyState:", ws.readyState);
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  stopAIPlayback();
  aiRecordBuffers = [[], []];
  aiRecordedSamples = 0;
  aiOverlapBuffers = [null, null];
  aiPlaybackQueue = [];
  aiChunksReceived = 0;
  aiChunksSent = 0;
  emitZeroLag();
}

function onAIAudioProcess(e) {
  if (!isAIMode(currentMode)) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    dbg("Karafilt: AI audio process skipped — WebSocket not open (state:", ws ? ws.readyState : "null", ")");
    return;
  }

  // Anchor the lag clock at the first real captured frame — this is the
  // program-time-0 the first played sample will also correspond to.
  if (aiCaptureStartCtxTime === null && audioContext) {
    aiCaptureStartCtxTime = audioContext.currentTime;
  }

  const left = e.inputBuffer.getChannelData(0);
  const right = e.inputBuffer.getChannelData(1);

  aiRecordBuffers[0].push(new Float32Array(left));
  aiRecordBuffers[1].push(new Float32Array(right));
  aiRecordedSamples += left.length;

  const chunkSize = AI_CHUNK_SECONDS * audioContext.sampleRate;
  if (aiRecordedSamples >= chunkSize) {
    sendAIChunk();
  }
}

function sendAIChunk() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !audioContext) {
    dbg("Karafilt: sendAIChunk skipped — ws:", ws ? ws.readyState : "null", "audioContext:", !!audioContext);
    return;
  }

  const totalSamples = aiRecordedSamples;
  dbg(`Karafilt: sending AI chunk — ${totalSamples} samples (${(totalSamples / audioContext.sampleRate).toFixed(1)}s)`);
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  let offset = 0;
  for (let i = 0; i < aiRecordBuffers[0].length; i++) {
    left.set(aiRecordBuffers[0][i], offset);
    right.set(aiRecordBuffers[1][i], offset);
    offset += aiRecordBuffers[0][i].length;
  }

  const interleaved = new Float32Array(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    interleaved[i * 2] = left[i];
    interleaved[i * 2 + 1] = right[i];
  }

  const header = new ArrayBuffer(8);
  const view = new DataView(header);
  view.setUint32(0, audioContext.sampleRate, true);
  view.setUint32(4, totalSamples, true);

  const packet = new Uint8Array(8 + interleaved.byteLength);
  packet.set(new Uint8Array(header), 0);
  packet.set(new Uint8Array(interleaved.buffer), 8);

  ws.send(packet.buffer);
  aiChunksSent++;
  dbg(`Sent ${totalSamples} samples (${(totalSamples / audioContext.sampleRate).toFixed(1)}s) to Demucs`);
  if (aiChunksReceived < AI_PREBUFFER_CHUNKS) {
    sendAIStatus("processing", { sent: aiChunksSent, received: aiChunksReceived });
  }

  // Keep the last overlap portion for the next chunk so the server
  // receives overlapping audio, enabling seamless boundary crossfades
  const overlapSamples = Math.round(AI_OVERLAP_SECONDS * audioContext.sampleRate);
  if (overlapSamples > 0 && totalSamples > overlapSamples) {
    const keepLeft = left.slice(totalSamples - overlapSamples);
    const keepRight = right.slice(totalSamples - overlapSamples);
    aiRecordBuffers = [[keepLeft], [keepRight]];
    aiRecordedSamples = overlapSamples;
  } else {
    aiRecordBuffers = [[], []];
    aiRecordedSamples = 0;
  }
}

// Schedule every buffered chunk onto the AudioContext timeline, back-to-back,
// so playback is gapless regardless of when chunks arrive. Playback only begins
// once the lead buffer (AI_PREBUFFER_CHUNKS) is filled; until then we stay
// silent (no STFT preview) — the user waits for clean AI output.
function scheduleReadyChunks() {
  if (!audioContext) return;

  if (!aiStarted) {
    if (aiChunksReceived < AI_PREBUFFER_CHUNKS) return; // keep waiting, silent
    // Lead filled — start gapless playback. Bring the AI output up (the worklet
    // preview stays muted) and anchor the timeline + lag clock.
    aiStarted = true;
    aiNextStartTime = audioContext.currentTime + 0.08; // small scheduling epsilon
    aiPlaybackStartCtxTime = aiNextStartTime;
    aiScheduledContentSeconds = 0;
    const now = audioContext.currentTime;
    if (workletGainNode) {
      workletGainNode.gain.cancelScheduledValues(now);
      workletGainNode.gain.setValueAtTime(workletGainNode.gain.value, now);
      workletGainNode.gain.linearRampToValueAtTime(0.0, now + 0.2);
    }
    if (aiOutputGainNode) {
      aiOutputGainNode.gain.cancelScheduledValues(now);
      aiOutputGainNode.gain.setValueAtTime(0.0, now);
      aiOutputGainNode.gain.linearRampToValueAtTime(1.0, now + 0.2);
    }
    sendAIStatus("ai_active");
  }

  while (aiPlaybackQueue.length > 0) {
    const chunk = aiPlaybackQueue.shift();
    // Underrun guard: if the cursor slipped behind the clock (ran dry — rare
    // with the lead buffer), resync to now. The small gap is reflected in lag.
    if (aiNextStartTime < audioContext.currentTime) {
      aiNextStartTime = audioContext.currentTime;
    }
    const buffer = audioContext.createBuffer(2, chunk.left.length, chunk.sampleRate);
    buffer.getChannelData(0).set(chunk.left);
    buffer.getChannelData(1).set(chunk.right);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(aiOutputGainNode);
    source.start(aiNextStartTime);

    const chunkDur = chunk.left.length / chunk.sampleRate;
    aiNextStartTime += chunkDur;
    aiScheduledContentSeconds += chunkDur;
    aiScheduledSources.push(source);
    source.onended = () => {
      const i = aiScheduledSources.indexOf(source);
      if (i !== -1) aiScheduledSources.splice(i, 1);
      // Drained mid-stream (rare with the lead buffer): show a brief re-buffer
      // instead of a stale "AI Active". Never reverts to the STFT preview;
      // playback resumes silently when the next chunk is scheduled.
      if (aiStarted && aiScheduledSources.length === 0 && aiPlaybackQueue.length === 0) {
        sendAIStatus("buffering");
      }
      reportLag();
    };
  }
  reportLag();
}

// Stop and clear all scheduled AI sources, resetting the playback timeline.
function stopAIPlayback() {
  for (const s of aiScheduledSources) {
    try { s.onended = null; s.stop(); } catch {}
  }
  aiScheduledSources = [];
  aiStarted = false;
  aiNextStartTime = null;
  aiPlaybackStartCtxTime = null;
  aiScheduledContentSeconds = 0;
}

function cleanupAudio() {
  captureReady = false;
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (aiBufferNode) { aiBufferNode.disconnect(); aiBufferNode = null; }
  if (aiGainNode) { aiGainNode.disconnect(); aiGainNode = null; }
  if (workletGainNode) { workletGainNode.disconnect(); workletGainNode = null; }
  if (aiOutputGainNode) { aiOutputGainNode.disconnect(); aiOutputGainNode = null; }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (audioContext) { audioContext.close(); audioContext = null; }
}

function fetchModelsFromServer() {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    if (!serverUrl) {
      done({ success: false, error: "No server configured" });
      return;
    }
    let tmpWs;
    try {
      tmpWs = new WebSocket(serverUrl);
    } catch (e) {
      done({ success: false, error: "Cannot connect to server" });
      return;
    }

    tmpWs.onopen = () => {
      if (apiKey) {
        tmpWs.send(JSON.stringify({ type: "auth", token: apiKey }));
      }
      tmpWs.send(JSON.stringify({ type: "get_models" }));
    };
    tmpWs.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === "models") {
          done({ success: true, models: data.models });
          // Close gracefully after a short delay to let the close frame complete
          setTimeout(() => tmpWs.close(), 100);
        }
      } catch (e) { /* ignore parse errors */ }
    };
    tmpWs.onerror = () => {
      done({ success: false, error: "Cannot connect to server" });
    };
    tmpWs.onclose = () => {
      done({ success: false, error: "Connection closed" });
    };
    // Timeout after 3 seconds
    setTimeout(() => {
      if (tmpWs.readyState === WebSocket.OPEN || tmpWs.readyState === WebSocket.CONNECTING) {
        tmpWs.close();
      }
      done({ success: false, error: "Server timeout" });
    }, 3000);
  });
}

function stopCapture() {
  dbg("Karafilt: stopCapture called");
  closeWebSocket();
  cleanupAudio();
  sendAIStatus("idle");
  currentMode = "stft";
}
