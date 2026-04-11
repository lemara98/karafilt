let audioContext = null;
let workletNode = null;
let sourceNode = null;
let mediaStream = null;
let ws = null;
let currentMode = "stft";
let currentAIModel = "htdemucs_ft";
let captureReady = false;

// AI mode state
const AI_CHUNK_SECONDS = 5;
const AI_OVERLAP_SECONDS = 1;  // overlap between consecutive chunks
const AI_PREBUFFER_CHUNKS = 2; // wait for 2 chunks before crossfading to AI
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[OFFSCREEN] received message:", message.type, "from:", sender.url || sender.id || "unknown");
  if (sender.tab) return;

  switch (message.type) {
    case "STREAM_READY":
      console.log("[OFFSCREEN] STREAM_READY received, mode:", message.mode, "aiModel:", message.aiModel);
      if (message.aiModel) currentAIModel = message.aiModel;
      startCapture(message.streamId, message.mode || "stft");
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
    case "GET_AI_MODELS":
      fetchModelsFromServer().then(sendResponse);
      return true; // async response
  }
});

async function startCapture(streamId, initialMode) {
  console.log(`[OFFSCREEN] startCapture called, mode=${initialMode}, streamId=${streamId}`);
  try {
    cleanupAudio();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

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
  } catch (err) {
    console.error("[OFFSCREEN] failed to start capture", err);
  }
}

function isAIMode(mode) {
  return mode === "ai" || mode === "ai2";
}

function switchMode(mode) {
  const wasAI = isAIMode(currentMode);
  console.log(`Karaoke Filter: switchMode "${currentMode}" → "${mode}" (captureReady=${captureReady})`);
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
    openWebSocket();
    // Tell the server which AI mode to use
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_two_pass", value: mode === "ai2" }));
    }
  } else if (wasAI && !isAIMode(mode)) {
    closeWebSocket();
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

  console.log("Karaoke Filter: connecting to Demucs backend...");
  ws = new WebSocket("ws://localhost:9876");
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log(`Karaoke Filter: connected to backend (mode=${currentMode}, model=${currentAIModel}, captureReady=${captureReady})`);
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

    // Wait for pre-buffer to fill before crossfading from STFT to AI
    if (aiChunksReceived === AI_PREBUFFER_CHUNKS && workletGainNode && workletGainNode.gain.value > 0.1) {
      const now = audioContext.currentTime;
      workletGainNode.gain.linearRampToValueAtTime(0.0, now + 0.5);
      aiOutputGainNode.gain.linearRampToValueAtTime(1.0, now + 0.5);
    }

    if (!aiPlaying && aiChunksReceived >= AI_PREBUFFER_CHUNKS) playNextAIChunk();
  };

  ws.onerror = (err) => {
    console.error("Karaoke Filter: WebSocket error", err);
  };

  ws.onclose = (event) => {
    console.log("Karaoke Filter: WebSocket closed, code:", event.code, "reason:", event.reason);
    // If unexpected close while in AI mode, fall back to STFT preview
    if (isAIMode(currentMode) && workletGainNode) {
      workletGainNode.gain.value = 1.0;
      if (aiOutputGainNode) aiOutputGainNode.gain.value = 0.0;
    }
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
}

function onAIAudioProcess(e) {
  if (!isAIMode(currentMode)) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log("Karaoke Filter: AI audio process skipped — WebSocket not open (state:", ws ? ws.readyState : "null", ")");
    return;
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
    console.log("Karaoke Filter: sendAIChunk skipped — ws:", ws ? ws.readyState : "null", "audioContext:", !!audioContext);
    return;
  }

  const totalSamples = aiRecordedSamples;
  console.log(`Karaoke Filter: sending AI chunk — ${totalSamples} samples (${(totalSamples / audioContext.sampleRate).toFixed(1)}s)`);
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
  console.log(`Sent ${totalSamples} samples (${(totalSamples / audioContext.sampleRate).toFixed(1)}s) to Demucs`);

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
    // If queue is empty and we're still in AI mode, fade back to STFT preview
    if (isAIMode(currentMode) && workletGainNode && aiOutputGainNode) {
      const now = audioContext.currentTime;
      workletGainNode.gain.linearRampToValueAtTime(1.0, now + 0.3);
      aiOutputGainNode.gain.linearRampToValueAtTime(0.0, now + 0.3);
    }
    return;
  }

  aiPlaying = true;
  const chunk = aiPlaybackQueue.shift();

  const buffer = audioContext.createBuffer(2, chunk.left.length, chunk.sampleRate);
  buffer.getChannelData(0).set(chunk.left);
  buffer.getChannelData(1).set(chunk.right);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(aiOutputGainNode);
  source.onended = playNextAIChunk;
  source.start();
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
      tmpWs = new WebSocket("ws://localhost:9876");
    } catch (e) {
      done({ success: false, error: "Cannot connect to server" });
      return;
    }

    tmpWs.onopen = () => {
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
  console.log("Karaoke Filter: stopCapture called");
  console.trace("stopCapture trace");
  closeWebSocket();
  cleanupAudio();
  currentMode = "stft";
}
