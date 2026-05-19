let audioContext = null;
let workletNode = null;
let sourceNode = null;
let mediaStream = null;
let ws = null;
let currentMode = "stft";
let currentAIModel = "htdemucs";
let captureReady = false;
let serverUrl = "ws://localhost:9876";
let apiKey = "";
let aiChunksSent = 0;

// ── Smart-sync alignment state ──────────────────────────────────────────────
// A separate WebSocket + capture tap that streams downsampled mono PCM to the
// backend's aligner. Independent of the AI vocal-removal mode — runs whenever
// the service worker requests alignment for the current song.
let alignWs = null;
let alignProcessor = null;
let alignSink = null;
let alignActive = false;
let alignSongKey = null;
let alignTabId = null;
let alignAccumulator = [];
let alignAccSamples = 0;
const ALIGN_TARGET_SR = 16000;
const ALIGN_SEND_INTERVAL_S = 5;

function sendAIStatus(status, detail) {
  chrome.runtime.sendMessage({ type: "AI_STATUS", status, detail });
}

// Server settings are pushed in from the service worker (offscreen
// docs can't access chrome.storage directly — only chrome.runtime).

// AI mode state. Chunk size kept at 5s because Demucs's hybrid transformer
// produces noticeably better separation with that much surrounding context;
// shorter chunks (we tried 2s) audibly degrade vocal isolation. Prebuffer
// stays at 1 chunk so the AI starts crossfading in sooner — worker pool
// keeps the queue from emptying in steady state.
const AI_CHUNK_SECONDS = 5;
const AI_OVERLAP_SECONDS = 1;   // overlap between consecutive chunks
const AI_PREBUFFER_CHUNKS = 1;  // wait for 1 chunk before crossfading to AI
let aiRecordBuffers = [[], []];
let aiRecordedSamples = 0;
let aiOverlapBuffers = [null, null]; // stores tail of previous chunk for overlap
let aiPlaybackQueue = [];
let aiPlaying = false;
let aiChunksReceived = 0;
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
let aiPlayedSamples = 0;              // cumulative samples of fully-played chunks
let aiCurrentChunkStartCtxTime = null;// ctx time the in-flight source.start() ran
let aiCurrentChunkSampleRate = 0;
let aiCurrentChunkSamples = 0;        // in-flight chunk length
let aiAudible = false;                // true only while AI output is the audible path
let lastReportedLag = -1;             // dedupe AI_LAG sends

function resetAILagState() {
  aiCaptureStartCtxTime = null;
  aiPlayedSamples = 0;
  aiCurrentChunkStartCtxTime = null;
  aiCurrentChunkSampleRate = 0;
  aiCurrentChunkSamples = 0;
  aiAudible = false;
  lastReportedLag = -1;
}

function computeLagSeconds() {
  if (!audioContext || !aiAudible || aiCaptureStartCtxTime === null) return 0;
  const capturedSeconds = audioContext.currentTime - aiCaptureStartCtxTime;
  let playedSeconds = aiPlayedSamples / audioContext.sampleRate;
  if (aiCurrentChunkSamples > 0 && aiCurrentChunkStartCtxTime !== null) {
    const elapsed = audioContext.currentTime - aiCurrentChunkStartCtxTime;
    const chunkDur = aiCurrentChunkSamples / aiCurrentChunkSampleRate;
    playedSeconds += Math.max(0, Math.min(elapsed, chunkDur));
  }
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
  console.log("[OFFSCREEN] received message:", message.type, "from:", sender.url || sender.id || "unknown");
  if (sender.tab) return;

  switch (message.type) {
    case "STREAM_READY":
      console.log("[OFFSCREEN] STREAM_READY received, mode:", message.mode, "aiModel:", message.aiModel);
      if (message.aiModel) currentAIModel = message.aiModel;
      if (message.serverUrl) serverUrl = message.serverUrl;
      if (typeof message.apiKey === "string") apiKey = message.apiKey;
      startCapture(message.streamId, message.mode || "stft");
      break;
    case "START_VIA_DISPLAY_MEDIA":
      console.log("[OFFSCREEN] START_VIA_DISPLAY_MEDIA received, mode:", message.mode);
      if (message.aiModel) currentAIModel = message.aiModel;
      if (message.serverUrl) serverUrl = message.serverUrl;
      if (typeof message.apiKey === "string") apiKey = message.apiKey;
      startCaptureViaDisplayMedia(message.mode || "stft");
      break;
    case "STOP_CAPTURE":
      console.log("[OFFSCREEN] STOP_CAPTURE received");
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
    case "START_ALIGNMENT":
      if (message.serverUrl) serverUrl = message.serverUrl;
      if (typeof message.apiKey === "string") apiKey = message.apiKey;
      startAlignment(message.songKey, message.lyrics, message.tabId);
      break;
    case "FINALIZE_ALIGNMENT":
      finalizeAlignment(message.songKey);
      break;
    case "CANCEL_ALIGNMENT":
      cancelAlignment(message.songKey);
      break;
  }
});

// ── Smart-sync alignment ────────────────────────────────────────────────────

function startAlignment(songKey, lyrics, tabId) {
  if (!audioContext || !sourceNode) {
    console.log("[OFFSCREEN][align] no audio source — capture must be active to align");
    chrome.runtime.sendMessage({
      type: "ALIGN_RESULT",
      songKey,
      tabId,
      ok: false,
      error: "capture_inactive",
    }).catch(() => {});
    return;
  }
  if (alignActive) {
    // A new alignment for a different song supersedes the previous one
    if (alignSongKey === songKey) {
      console.log("[OFFSCREEN][align] already aligning this song — ignoring");
      return;
    }
    cancelAlignment(alignSongKey);
  }

  console.log(`[OFFSCREEN][align] starting alignment for songKey=${songKey}, tabId=${tabId}`);
  alignActive = true;
  alignSongKey = songKey;
  alignTabId = tabId != null ? tabId : null;
  alignAccumulator = [];
  alignAccSamples = 0;

  const inputSR = audioContext.sampleRate;
  const ratio = inputSR / ALIGN_TARGET_SR;

  // Mono downsample tap. ScriptProcessor is deprecated but matches the existing
  // aiBufferNode pattern and is sufficient for non-realtime capture.
  alignProcessor = audioContext.createScriptProcessor(4096, 2, 1);
  alignProcessor.onaudioprocess = (e) => {
    if (!alignActive) return;
    const left = e.inputBuffer.getChannelData(0);
    const right = e.inputBuffer.getChannelData(1);
    const len = left.length;
    const outLen = Math.max(1, Math.floor(len / ratio));
    const out = new Float32Array(outLen);
    // Cheap nearest-neighbor downsample with stereo→mono mix. Quality is fine
    // for Whisper which expects 16kHz speech-grade input.
    for (let i = 0; i < outLen; i++) {
      const srcIdx = Math.min(len - 1, Math.floor(i * ratio));
      out[i] = (left[srcIdx] + right[srcIdx]) * 0.5;
    }
    alignAccumulator.push(out);
    alignAccSamples += outLen;
    if (alignAccSamples >= ALIGN_TARGET_SR * ALIGN_SEND_INTERVAL_S) {
      flushAlignChunk();
    }
  };

  // ScriptProcessor must be connected to a destination to fire onaudioprocess.
  alignSink = audioContext.createGain();
  alignSink.gain.value = 0; // silent — we don't want to play this back
  sourceNode.connect(alignProcessor);
  alignProcessor.connect(alignSink);
  alignSink.connect(audioContext.destination);

  openAlignWebSocket(songKey, lyrics);
}

function openAlignWebSocket(songKey, lyrics) {
  try {
    alignWs = new WebSocket(serverUrl);
  } catch (err) {
    console.warn("[OFFSCREEN][align] failed to open WS:", err);
    notifyAlignResult({ songKey, ok: false, error: "ws_open_failed" });
    cleanupAlignment();
    return;
  }
  alignWs.binaryType = "arraybuffer";

  alignWs.onopen = () => {
    if (apiKey) alignWs.send(JSON.stringify({ type: "auth", token: apiKey }));
    alignWs.send(JSON.stringify({
      type: "align_start",
      song_key: songKey,
      lyrics: lyrics || "",
      sample_rate: ALIGN_TARGET_SR,
    }));
    console.log("[OFFSCREEN][align] WS open, align_start sent");
  };

  alignWs.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "align_result") {
      console.log("[OFFSCREEN][align] received align_result:", msg.ok ? "ok" : msg.error);
      notifyAlignResult({
        songKey: msg.song_key || songKey,
        ok: !!msg.ok,
        lines: msg.lines || null,
        error: msg.error || null,
      });
      cleanupAlignment();
    }
  };

  alignWs.onerror = (err) => {
    console.warn("[OFFSCREEN][align] WS error:", err);
  };

  alignWs.onclose = (evt) => {
    console.log("[OFFSCREEN][align] WS closed:", evt.code, evt.reason);
    if (alignActive) {
      // Lost the connection mid-alignment — surface as failure
      notifyAlignResult({ songKey, ok: false, error: "ws_closed" });
      cleanupAlignment();
    }
  };
}

function flushAlignChunk() {
  if (!alignWs || alignWs.readyState !== WebSocket.OPEN) return;
  const total = alignAccSamples;
  if (total === 0) return;
  const buf = new Float32Array(total);
  let off = 0;
  for (const c of alignAccumulator) {
    buf.set(c, off);
    off += c.length;
  }
  alignAccumulator = [];
  alignAccSamples = 0;

  const header = new ArrayBuffer(8);
  const view = new DataView(header);
  view.setUint32(0, ALIGN_TARGET_SR, true);
  view.setUint32(4, total, true);
  const packet = new Uint8Array(8 + buf.byteLength);
  packet.set(new Uint8Array(header), 0);
  packet.set(new Uint8Array(buf.buffer), 8);
  alignWs.send(packet.buffer);
}

function finalizeAlignment(songKey) {
  if (!alignActive) return;
  if (songKey && songKey !== alignSongKey) return;
  console.log("[OFFSCREEN][align] finalizing alignment for", alignSongKey);
  flushAlignChunk();
  if (alignWs && alignWs.readyState === WebSocket.OPEN) {
    alignWs.send(JSON.stringify({ type: "align_finalize" }));
    // Don't cleanup yet — wait for align_result (cleanupAlignment fires in onmessage)
    // Tear down the audio tap immediately so we stop buffering.
    teardownAlignProcessor();
    alignActive = false;
  } else {
    notifyAlignResult({ songKey: alignSongKey, ok: false, error: "ws_unavailable" });
    cleanupAlignment();
  }
}

function cancelAlignment(songKey) {
  if (!alignActive) return;
  if (songKey && songKey !== alignSongKey) return;
  console.log("[OFFSCREEN][align] cancelling alignment for", alignSongKey);
  if (alignWs && alignWs.readyState === WebSocket.OPEN) {
    try { alignWs.send(JSON.stringify({ type: "align_cancel" })); } catch {}
  }
  cleanupAlignment();
}

function teardownAlignProcessor() {
  if (alignProcessor) {
    try { alignProcessor.disconnect(); } catch {}
    alignProcessor.onaudioprocess = null;
    alignProcessor = null;
  }
  if (alignSink) {
    try { alignSink.disconnect(); } catch {}
    alignSink = null;
  }
}

function cleanupAlignment() {
  teardownAlignProcessor();
  if (alignWs) {
    try { alignWs.close(); } catch {}
    alignWs = null;
  }
  alignActive = false;
  alignSongKey = null;
  alignTabId = null;
  alignAccumulator = [];
  alignAccSamples = 0;
}

function notifyAlignResult({ songKey, ok, lines, error }) {
  chrome.runtime.sendMessage({
    type: "ALIGN_RESULT",
    songKey,
    tabId: alignTabId,
    ok,
    lines: lines || null,
    error: error || null,
  }).catch(() => {});
}

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
  console.log(`[OFFSCREEN] capture started, sample rate: ${audioContext.sampleRate}, about to switchMode("${initialMode}")`);

  switchMode(initialMode);
  console.log(`[OFFSCREEN] switchMode complete, ws=${ws ? ws.readyState : "null"}, currentMode=${currentMode}`);
}

async function startCapture(streamId, initialMode) {
  console.log(`[OFFSCREEN] startCapture called, mode=${initialMode}, streamId=${streamId}`);
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
  console.log(`[OFFSCREEN] startCaptureViaDisplayMedia called, mode=${initialMode}`);
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
  console.log(`Karafilt: switchMode "${currentMode}" → "${mode}" (captureReady=${captureReady})`);
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
    // Worklet stays at full volume as preview until AI chunks arrive
    if (workletGainNode) workletGainNode.gain.value = 1.0;
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

  aiRecordBuffers = [[], []];
  aiRecordedSamples = 0;
  aiOverlapBuffers = [null, null];
  aiPlaybackQueue = [];
  aiPlaying = false;
  aiChunksReceived = 0;

  console.log(`Karafilt: connecting to backend at ${serverUrl}...`);
  ws = new WebSocket(serverUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log(`Karafilt: connected to backend (mode=${currentMode}, model=${currentAIModel}, captureReady=${captureReady})`);
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
    console.log(`Received ${numSamples} processed samples from Demucs (chunk #${aiChunksReceived})`);

    if (aiChunksReceived < AI_PREBUFFER_CHUNKS) {
      sendAIStatus("buffering", { received: aiChunksReceived, needed: AI_PREBUFFER_CHUNKS });
    }

    // Wait for pre-buffer to fill before crossfading from STFT to AI
    if (aiChunksReceived === AI_PREBUFFER_CHUNKS && workletGainNode && workletGainNode.gain.value > 0.1) {
      const now = audioContext.currentTime;
      workletGainNode.gain.linearRampToValueAtTime(0.0, now + 0.5);
      aiOutputGainNode.gain.linearRampToValueAtTime(1.0, now + 0.5);
      sendAIStatus("ai_active");

      // The queued AI audio represents content from ~aiCaptureStartCtxTime
      // onwards, but the video element has advanced (now - that) seconds
      // beyond it. Seek the video back so frames match the audio about to
      // play. Re-anchor the lag clock so lyric-sync reports ~0 during the
      // synced window. Drift may return after the prebuffered chunks play
      // out (duplicate captures during the rewatch period); toggling AI
      // off/on re-syncs.
      if (aiCaptureStartCtxTime !== null) {
        const seekBackSeconds = now - aiCaptureStartCtxTime;
        if (seekBackSeconds > 0.05) {
          chrome.runtime.sendMessage({
            type: "MEDIA_SEEK_RELATIVE",
            deltaSeconds: -seekBackSeconds,
          }).catch(() => {});
          aiCaptureStartCtxTime = now;
          aiPlayedSamples = 0;
        }
      }
    }

    if (!aiPlaying && aiChunksReceived >= AI_PREBUFFER_CHUNKS) playNextAIChunk();
  };

  ws.onerror = (err) => {
    console.error("Karafilt: WebSocket error", err);
    sendAIStatus("error");
  };

  ws.onclose = (event) => {
    console.log("Karafilt: WebSocket closed, code:", event.code, "reason:", event.reason);
    // If unexpected close while in AI mode, fall back to STFT preview
    if (isAIMode(currentMode) && workletGainNode) {
      workletGainNode.gain.value = 1.0;
      if (aiOutputGainNode) aiOutputGainNode.gain.value = 0.0;
      sendAIStatus("fallback");
    }
    emitZeroLag();
  };
}

function closeWebSocket() {
  if (ws) {
    console.log("[OFFSCREEN] closeWebSocket called, ws.readyState:", ws.readyState);
    console.trace("[OFFSCREEN] closeWebSocket trace");
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  aiRecordBuffers = [[], []];
  aiRecordedSamples = 0;
  aiOverlapBuffers = [null, null];
  aiPlaybackQueue = [];
  aiPlaying = false;
  aiChunksReceived = 0;
  aiChunksSent = 0;
  emitZeroLag();
}

function onAIAudioProcess(e) {
  if (!isAIMode(currentMode)) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log("Karafilt: AI audio process skipped — WebSocket not open (state:", ws ? ws.readyState : "null", ")");
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
    console.log("Karafilt: sendAIChunk skipped — ws:", ws ? ws.readyState : "null", "audioContext:", !!audioContext);
    return;
  }

  const totalSamples = aiRecordedSamples;
  console.log(`Karafilt: sending AI chunk — ${totalSamples} samples (${(totalSamples / audioContext.sampleRate).toFixed(1)}s)`);
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
  console.log(`Sent ${totalSamples} samples (${(totalSamples / audioContext.sampleRate).toFixed(1)}s) to Demucs`);
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

function playNextAIChunk() {
  if (!audioContext || aiPlaybackQueue.length === 0) {
    aiPlaying = false;
    // Queue drained — fold the chunk that just finished, then the audible
    // output is the near-zero-latency STFT preview again, so lag is 0.
    if (aiCurrentChunkSamples > 0) aiPlayedSamples += aiCurrentChunkSamples;
    aiCurrentChunkSamples = 0;
    aiCurrentChunkStartCtxTime = null;
    aiAudible = false;
    // If queue is empty and we're still in AI mode, fade back to STFT preview
    if (isAIMode(currentMode) && workletGainNode && aiOutputGainNode) {
      const now = audioContext.currentTime;
      workletGainNode.gain.linearRampToValueAtTime(1.0, now + 0.3);
      aiOutputGainNode.gain.linearRampToValueAtTime(0.0, now + 0.3);
      sendAIStatus("stft_preview");
    }
    reportLag();
    return;
  }

  aiPlaying = true;
  const chunk = aiPlaybackQueue.shift();

  // The chunk that was in flight has now finished (onended fired) — fold its
  // full length into the played total before tracking the new one.
  if (aiCurrentChunkSamples > 0) aiPlayedSamples += aiCurrentChunkSamples;
  aiCurrentChunkSamples = chunk.left.length;
  aiCurrentChunkSampleRate = chunk.sampleRate;
  aiCurrentChunkStartCtxTime = audioContext.currentTime;
  aiAudible = true;

  const buffer = audioContext.createBuffer(2, chunk.left.length, chunk.sampleRate);
  buffer.getChannelData(0).set(chunk.left);
  buffer.getChannelData(1).set(chunk.right);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(aiOutputGainNode);
  source.onended = playNextAIChunk;
  source.start();

  reportLag();
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
  console.log("Karafilt: stopCapture called");
  console.trace("stopCapture trace");
  closeWebSocket();
  // Finalize any in-flight alignment before tearing down the AudioContext
  if (alignActive) {
    finalizeAlignment(alignSongKey);
  } else {
    cleanupAlignment();
  }
  cleanupAudio();
  sendAIStatus("idle");
  currentMode = "stft";
}
