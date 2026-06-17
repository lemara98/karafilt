// Karafilt read-ahead — PHASE 2a (isolated world, youtube.com).
//
// Receives decoded look-ahead PCM from the MAIN-world injector
// (window.postMessage "KFL_LOOKAHEAD_PCM"), and plays it SYNCED to the video:
// a block whose content-time is T is scheduled to come out of the speakers when
// video.currentTime reaches T. The original YouTube audio is muted so you hear
// only our pipeline. No pod yet — this proves transport + sync + mute. Phase 2b
// inserts the pod (vocal removal) between receive and play.
//
// Local research only; gated behind localStorage.kflLookahead='1' (then reload).

(() => {
  if (window.__kflLookaheadRx) return;
  window.__kflLookaheadRx = true;

  let LIVE = false;
  try { LIVE = localStorage.getItem("kflLookahead") === "1"; } catch {}
  if (!LIVE) return;

  const TAG = "[KFL-Live]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  log("active — will play look-ahead audio synced to the video (YouTube muted). 'KFL-Live' in console.");

  let ctx = null;
  let video = null;
  let mutedByUs = false;
  let firstBlock = true;
  const sources = new Set();

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Autoplay policy: resume on the next user gesture if it starts suspended.
      const resume = () => { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); };
      resume();
      window.addEventListener("click", resume, true);
      window.addEventListener("keydown", resume, true);
      document.addEventListener("play", resume, true);
    }
    return ctx;
  }

  function findVideo() {
    if (video && document.contains(video)) return video;
    const vids = Array.from(document.querySelectorAll("video"));
    video = vids.find((v) => v.currentTime > 0 || !v.paused) || vids[0] || null;
    return video;
  }

  function muteOriginal() {
    const v = findVideo();
    if (v && !v.muted) { v.muted = true; mutedByUs = true; }
  }
  function restoreOriginal() {
    if (mutedByUs && video) { try { video.muted = false; } catch {} mutedByUs = false; }
  }

  function onPcm(contentTime, rate, channels, pcm) {
    const v = findVideo();
    if (!v) return;
    muteOriginal();
    const audio = getCtx();

    const frames = Math.floor(pcm.length / channels);
    if (frames <= 0) return;
    const ab = audio.createBuffer(channels, frames, rate);
    for (let c = 0; c < channels; c++) {
      const ch = ab.getChannelData(c);
      for (let i = 0; i < frames; i++) ch[i] = pcm[i * channels + c];
    }

    // Schedule so content-time T is audible when video.currentTime == T.
    const delta = contentTime - v.currentTime;        // seconds the block leads the playhead
    const startAt = audio.currentTime + delta;
    if (delta < -0.25) return;                         // already past — drop
    const when = Math.max(startAt, audio.currentTime + 0.01);

    const src = audio.createBufferSource();
    src.buffer = ab;
    src.connect(audio.destination);
    src.onended = () => sources.delete(src);
    try { src.start(when); } catch { return; }
    sources.add(src);

    if (firstBlock) {
      firstBlock = false;
      log(`first block: content t=${contentTime.toFixed(2)}s, playhead=${v.currentTime.toFixed(2)}s, lead=${delta.toFixed(2)}s → playing synced, YouTube muted.`);
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.kfl !== "KFL_LOOKAHEAD_PCM") return;
    try {
      onPcm(e.data.contentTime, e.data.sampleRate, e.data.channels, new Float32Array(e.data.pcm));
    } catch (err) {
      warn("onPcm failed:", err && err.message);
    }
  });

  // Tear down on navigation away.
  window.addEventListener("pagehide", () => {
    for (const s of sources) { try { s.stop(); } catch {} }
    sources.clear();
    restoreOriginal();
  });
})();
