// Karafilt read-ahead — PHASE 2c (isolated world, youtube.com).
//
// Receives decoded look-ahead PCM from the MAIN-world injector and plays it
// SYNCED to the video (YouTube muted).
//   • RAW mode: play the look-ahead audio as-is (no vocal removal).
//   • POD mode: stream it to the Demucs pod and play the vocal-removed result.
//
// POD mode uses a pause-to-buffer startup (a brief "loading" pause, then zero gap)
// and a processed-chunk store + clock scheduler so playback stays synced and
// pause/resume is instant. Batches ramp small→15s.
//
// Enable: localStorage.kflLookahead='1'. For the pod, also set
//   localStorage.kflPod = 'wss://<pod>-9876.proxy.runpod.net'  (open-mode server)
//   localStorage.kflPodKey = '<token>'   (only if the server uses --auth-token)
// Local research only.

(() => {
  if (window.__kflLookaheadRx) return;
  window.__kflLookaheadRx = true;

  let LIVE = false, POD_URL = "", POD_KEY = "";
  try { LIVE = localStorage.getItem("kflLookahead") === "1"; } catch {}
  try { POD_URL = localStorage.getItem("kflPod") || ""; } catch {}
  try { POD_KEY = localStorage.getItem("kflPodKey") || ""; } catch {}
  if (!LIVE) return;

  const TAG = "[KFL-Live]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  log(`active — ${POD_URL ? "POD mode → " + POD_URL : "RAW mode (set localStorage.kflPod to filter)"}. YouTube muted.`);

  const OVERLAP_S = 1;        // crossfade overlap between consecutive batches
  const FIRST_BATCH_S = 8;    // small first batch → short startup load
  const BATCH_S = 15;         // steady-state batch (fewer seams / round-trips)
  const MAX_LEAD_S = 18;      // don't send batches starting more than this far ahead
  const RESUME_LEAD_S = 6;    // processed audio to buffer before un-pausing

  let ctx = null, video = null, mutedByUs = false, wired = false;
  const sources = new Set();

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const resume = () => { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); };
      resume();
      window.addEventListener("click", resume, true);
      window.addEventListener("keydown", resume, true);
    }
    return ctx;
  }
  function findVideo() {
    if (video && document.contains(video)) return video;
    const vids = Array.from(document.querySelectorAll("video"));
    video = vids.find((v) => v.currentTime > 0 || !v.paused) || vids[0] || null;
    return video;
  }
  function muteOriginal() { const v = findVideo(); if (v && !v.muted) { v.muted = true; mutedByUs = true; } }
  function stopAll() { for (const s of sources) { try { s.onended = null; s.stop(); } catch {} } sources.clear(); }
  function concatF32(a, b) { const o = new Float32Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

  // ── state ──────────────────────────────────────────────────────────────
  let ws = null, wsReady = false;
  let tlStart = null, tlL = new Float32Array(0), tlR = new Float32Array(0), tlRate = 48000; // decoded timeline
  let sendCursor = null, chunkIdx = 0;
  const inflight = [];                 // FIFO of content-start-times for sent batches
  let prevTailL = null, prevTailR = null;
  const processedStore = [];           // [{start, L, R, rate, scheduled}], sorted by start
  let mode = "IDLE";                   // IDLE | BUFFERING | PLAYING (POD mode)
  let pausePos = 0;
  let schedTimer = null;

  function wireVideo(v) {
    if (wired || !v) return;
    wired = true;
    v.addEventListener("seeking", stopAll);
    v.addEventListener("seeked", resetForSeek);
    // Reset "scheduled" flags only on PAUSE (so resume re-schedules). Doing it on
    // play too would re-schedule chunks already playing → a phasey double.
    v.addEventListener("pause", () => { stopAll(); markFutureUnscheduled(); });
    v.addEventListener("play", () => { scheduler(); });
    v.addEventListener("ended", stopAll);
    // YouTube can re-unmute the element on programmatic play/pause — keep it muted.
    v.addEventListener("volumechange", () => { if (mutedByUs && !v.muted) v.muted = true; });
  }

  function markFutureUnscheduled() {
    const v = findVideo(); if (!v) return;
    for (const c of processedStore) if (c.start + c.L.length / c.rate > v.currentTime) c.scheduled = false;
  }
  function resetForSeek() {
    stopAll();
    tlStart = null; tlL = new Float32Array(0); tlR = new Float32Array(0);
    const v = findVideo();
    sendCursor = v ? v.currentTime : null;
    chunkIdx = 0;
    inflight.length = 0;
    prevTailL = prevTailR = null;
    processedStore.length = 0;
    // stay in PLAYING (no extra pause per seek); the scheduler partial-plays the
    // first late chunk so the seek recovers with only a brief delay.
    if (mode === "BUFFERING") mode = "PLAYING";
  }

  // ── POD streaming ──────────────────────────────────────────────────────
  function connectWS() {
    if (!POD_URL || ws) return;
    try { ws = new WebSocket(POD_URL); } catch (e) { warn("WebSocket ctor failed:", e && e.message); return; }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (POD_KEY) ws.send(JSON.stringify({ type: "auth", token: POD_KEY }));
      ws.send(JSON.stringify({ type: "set_model", value: "htdemucs" }));
      ws.send(JSON.stringify({ type: "set_two_pass", value: false }));
      wsReady = !POD_KEY;
      log(`pod connected (${POD_KEY ? "auth sent" : "open mode"}).`);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        try { const m = JSON.parse(e.data); if (m.type === "auth") { wsReady = m.status === "ok"; log("pod auth: " + m.status); } } catch {}
        return;
      }
      handleProcessed(e.data);
    };
    ws.onerror = () => warn("pod WebSocket error — running and reachable at " + POD_URL + " ?");
    ws.onclose = () => { wsReady = false; ws = null; warn("pod connection closed."); };
  }

  function accumulate(t, rate, ch, pcm) {
    const n = Math.floor(pcm.length / ch);
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = pcm[i * ch]; R[i] = ch > 1 ? pcm[i * ch + 1] : pcm[i * ch]; }
    tlRate = rate;
    if (tlStart === null) { tlStart = t; tlL = L; tlR = R; if (sendCursor === null) sendCursor = t; return; }
    const expectedNext = tlStart + tlL.length / rate;
    if (Math.abs(t - expectedNext) > 0.2) { tlStart = t; tlL = L; tlR = R; sendCursor = t; return; } // discontinuity
    tlL = concatF32(tlL, L); tlR = concatF32(tlR, R);
  }

  function chunker() {
    if (!wsReady || tlStart === null || sendCursor === null) return;
    const v = findVideo();
    const rate = tlRate;
    while (true) {
      const size = chunkIdx === 0 ? FIRST_BATCH_S : BATCH_S;
      const haveEnd = tlStart + tlL.length / rate;
      if (sendCursor + size > haveEnd) break;                       // not enough buffered
      if (v && sendCursor > v.currentTime + MAX_LEAD_S) break;      // far enough ahead
      const off = Math.round((sendCursor - tlStart) * rate);
      if (off < 0) { sendCursor += size - OVERLAP_S; chunkIdx++; continue; }
      const need = Math.round(size * rate);
      const L = tlL.subarray(off, off + need), R = tlR.subarray(off, off + need);
      const inter = new Float32Array(need * 2);
      for (let i = 0; i < need; i++) { inter[i * 2] = L[i]; inter[i * 2 + 1] = R[i]; }
      const pkt = new Uint8Array(8 + inter.byteLength);
      const dv = new DataView(pkt.buffer);
      dv.setUint32(0, rate, true); dv.setUint32(4, need, true);
      pkt.set(new Uint8Array(inter.buffer), 8);
      try { ws.send(pkt.buffer); inflight.push(sendCursor); } catch (e) { warn("send failed:", e && e.message); break; }
      sendCursor += size - OVERLAP_S;
      chunkIdx++;
    }
    const keep = Math.round((sendCursor - 2 - tlStart) * rate);       // prune sent prefix
    if (keep > rate * 5) { tlL = tlL.slice(keep); tlR = tlR.slice(keep); tlStart += keep / rate; }
  }

  function insertProcessed(start, L, R, rate) {
    const c = { start, L, R, rate, scheduled: false };
    const n = processedStore.length;
    if (n === 0 || start >= processedStore[n - 1].start) { processedStore.push(c); return; }
    let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (processedStore[m].start < start) lo = m + 1; else hi = m; }
    processedStore.splice(lo, 0, c);
  }

  function handleProcessed(data) {
    const dv = new DataView(data);
    const rate = dv.getUint32(0, true);
    const n = dv.getUint32(4, true);
    const pcm = new Float32Array(data, 8);
    let L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = pcm[i * 2]; R[i] = pcm[i * 2 + 1]; }
    const contentStart = inflight.shift();
    if (contentStart === undefined) return;
    const ov = Math.round(OVERLAP_S * rate);
    if (prevTailL && ov > 0) {                       // crossfade boundary with previous batch
      const fl = Math.min(prevTailL.length, ov, n);
      for (let i = 0; i < fl; i++) { const t = i / fl; L[i] = prevTailL[i] * (1 - t) + L[i] * t; R[i] = prevTailR[i] * (1 - t) + R[i] * t; }
    }
    let pL = L, pR = R;
    if (ov > 0 && n > ov) {                          // save tail, trim so the overlap isn't replayed
      const tail = n - ov;
      prevTailL = L.slice(tail); prevTailR = R.slice(tail);
      pL = L.slice(0, tail); pR = R.slice(0, tail);
    }
    insertProcessed(contentStart, pL, pR, rate);
    if (mode === "BUFFERING") tryStartPlaying();
    else scheduler();
  }

  // ── pause-to-buffer + scheduling ───────────────────────────────────────
  function enterBuffering() {
    const v = findVideo(); if (!v) return;
    pausePos = v.currentTime;
    sendCursor = pausePos;
    chunkIdx = 0;
    mode = "BUFFERING";
    muteOriginal();
    try { v.pause(); } catch {}
    log(`buffering from ${pausePos.toFixed(2)}s (paused to load)…`);
  }

  function tryStartPlaying() {
    // contiguous processed coverage from pausePos?
    let expect = pausePos;
    for (const c of processedStore) {
      const end = c.start + c.L.length / c.rate;
      if (c.start <= expect + 0.1 && end > expect) expect = end;
    }
    if (expect - pausePos >= RESUME_LEAD_S) {
      mode = "PLAYING";
      log(`buffered ${(expect - pausePos).toFixed(1)}s → playing from ${pausePos.toFixed(2)}s (zero-gap).`);
      const v = findVideo();
      if (v) v.play().catch(() => {});
      scheduler();
    }
  }

  function scheduler() {
    if (mode !== "PLAYING") return;
    const v = findVideo();
    if (!v || v.paused) return;
    muteOriginal();                                  // re-assert (YouTube can unmute)
    const audio = getCtx();
    const aheadLimit = v.currentTime + 5;            // schedule batches starting within 5s
    for (const c of processedStore) {
      if (c.scheduled || c.start > aheadLimit) continue;
      c.scheduled = true;
      let L = c.L, R = c.R, start = c.start, len = L.length;
      const behind = v.currentTime - start;
      if (behind > 0.05) {                            // partial-play: trim the already-past part
        const skip = Math.round(behind * c.rate);
        if (skip >= len) continue;                    // entirely past
        L = L.subarray(skip); R = R.subarray(skip); len = L.length; start += skip / c.rate;
      }
      const ab = audio.createBuffer(2, len, c.rate);
      ab.getChannelData(0).set(L); ab.getChannelData(1).set(R);
      const when = Math.max(audio.currentTime + (start - v.currentTime), audio.currentTime + 0.01);
      const src = audio.createBufferSource();
      src.buffer = ab; src.connect(audio.destination);
      src.onended = () => sources.delete(src);
      try { src.start(when); sources.add(src); } catch {}
    }
    // prune scheduled batches fully behind the playhead
    const cut = v.currentTime - 1;
    while (processedStore.length && processedStore[0].scheduled &&
           processedStore[0].start + processedStore[0].L.length / processedStore[0].rate < cut) {
      processedStore.shift();
    }
  }

  // ── RAW playback (no pod) ──────────────────────────────────────────────
  function playRaw(contentTime, rate, channels, pcm) {
    const v = findVideo(); if (!v || v.paused) return;
    muteOriginal();
    const audio = getCtx();
    const n = Math.floor(pcm.length / channels);
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = pcm[i * channels]; R[i] = channels > 1 ? pcm[i * channels + 1] : pcm[i * channels]; }
    const delta = contentTime - v.currentTime;
    if (delta < -0.25) return;
    const ab = audio.createBuffer(2, n, rate);
    ab.getChannelData(0).set(L); ab.getChannelData(1).set(R);
    const src = audio.createBufferSource();
    src.buffer = ab; src.connect(audio.destination);
    src.onended = () => sources.delete(src);
    try { src.start(Math.max(audio.currentTime + delta, audio.currentTime + 0.01)); sources.add(src); } catch {}
  }

  // ── PCM intake ─────────────────────────────────────────────────────────
  function onPcm(contentTime, rate, channels, pcm) {
    const v = findVideo();
    if (!v) return;
    wireVideo(v);
    if (!POD_URL) { playRaw(contentTime, rate, channels, pcm); return; }
    connectWS();
    if (mode === "IDLE") enterBuffering();
    accumulate(contentTime, rate, channels, pcm);
    chunker();
    if (!schedTimer) schedTimer = setInterval(scheduler, 100);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.kfl !== "KFL_LOOKAHEAD_PCM") return;
    try { onPcm(e.data.contentTime, e.data.sampleRate, e.data.channels, new Float32Array(e.data.pcm)); }
    catch (err) { warn("onPcm failed:", err && err.message); }
  });

  window.addEventListener("pagehide", () => {
    stopAll();
    if (mutedByUs && video) { try { video.muted = false; } catch {} }
    if (ws) { try { ws.close(); } catch {} }
  });
})();
