// Listen-along lyrics aligner (offscreen page side).
//
// While the vocal filter plays, a passive tap worklet (alignment-tap.js)
// streams a vocal-band energy envelope here. This module maps that envelope
// onto media time (via the content script's PLAYBACK_TIME ticks), watches
// which lyric lines were fully covered by continuous playback, detects
// syllable onsets inside each covered line, distributes the line's words
// over them, and submits the result as a per-line observation to a Karalyr
// server. Karalyr aggregates observations across users/plays and publishes
// an auto-aligned word-timed revision once coverage is good enough.
//
// Isolation guarantees:
//  - separate AudioWorkletNode; the vocal-remove graph is untouched
//  - everything here is wrapped so a failure only disables alignment
//  - network I/O is fire-and-forget, rate-limited by song structure
(function () {
  "use strict";

  const KF_DEBUG = false;
  const dbg = (...args) => { if (KF_DEBUG) console.log("[KF-ALIGN]", ...args); };

  // Same host as the service worker's karalyrBase; overridable through
  // chrome.storage.local.karalyrBase for a local server. Unused while the
  // aligner is disabled, but a stale localhost default would be a trap for
  // whoever re-enables it.
  const DEFAULT_BASE = "https://www.karalyr.com";
  const CAPTURE_LATENCY_SEC = 0.03; // tabCapture → worklet, rough constant
  const MIN_CLOCK_PAIRS = 5;
  const MAX_CLOCK_PAIRS = 40;
  const RING_BLOCKS = 131072; // ~23 min of 512-sample blocks @ 48k
  const SPAN_PAD_SEC = 0.2;
  const LINE_DONE_MARGIN_SEC = 0.5;
  const MIN_CONFIDENCE = 0.35;
  const MAX_LINE_SEC = 12; // last line / gap cap

  const core = self.KFAlignCore;

  // DISABLED — do not flip to `true` without fixing syllableCount first.
  //
  // Onset detection itself is language-agnostic (it is signal processing on an
  // energy envelope), but syllableCount in shared/align-core.js decides how a
  // line's words are spread across those onsets, and it is English-shaped.
  // Measured against 29 known words it got 11 wrong, including 4 of 9 Serbian:
  //
  //   - its keep-filter [^a-zà-öø-ÿ] strips Latin Extended-A (š č ć ž đ ł ı),
  //     which merges neighbouring vowel groups: "duša" -> "dua" -> 1 syllable
  //   - the English silent-e rule fires on every language: "moje", "srce" -> 1
  //   - ç ñ ð þ sit inside à-ö and so count as vowels (Spanish, Portuguese)
  //   - Cyrillic strips to empty, so every word scores 1 and the distribution
  //     collapses to even spacing — the exact thing this feature exists to beat
  //
  // Fix: transliterate before stripping (the tables in karalyr's lib/song-key.ts
  // already cover Cyrillic and đ), drop the diacritic consonants from the vowel
  // class, and gate the silent-e rule to English. Then re-run that word list as
  // a test before re-enabling.
  //
  // Until then songs are only *marked* for review: see maybeQueueWordSync in
  // sidepanel.js, which queues them for an admin to approve — no guessed timing
  // is ever published.
  let enabled = false;
  let ctx = null;
  let tapNode = null;
  let muteGain = null;
  let boundTabId = null;
  let sampleRate = 48000;

  // Energy ring, indexed by absolute block index (startSample / 512).
  let ring = null;
  let maxBlockIdx = -1;

  // media-time ↔ context-time mapping
  let clockPairs = []; // {media, ctx}
  let lastTick = null; // {media, wall}

  // lyrics + coverage state for the current song
  let songKey = null;
  let meta = null; // {artistName, trackName}
  let mediaDuration = 0;
  let lines = []; // {startSec, endSec, text, done, sent}
  let spans = []; // covered media-time spans [{a, b}]

  let baseUrl = DEFAULT_BASE;
  try {
    chrome.storage.local.get(["alignEnabled", "karalyrBase"]).then((v) => {
      if (v && v.alignEnabled === false) enabled = false;
      if (v && typeof v.karalyrBase === "string" && v.karalyrBase) baseUrl = v.karalyrBase;
    }).catch(() => {});
  } catch (e) { /* storage unavailable — keep defaults */ }

  // ---------------------------------------------------------------- attach
  async function attach(opts) {
    if (!enabled || !core) return;
    try {
      ctx = opts.audioContext;
      boundTabId = opts.tabId != null ? opts.tabId : null;
      sampleRate = ctx.sampleRate;
      ring = new Float32Array(RING_BLOCKS);
      maxBlockIdx = -1;
      resetSong(null);

      await ctx.audioWorklet.addModule(chrome.runtime.getURL("alignment-tap.js"));
      tapNode = new AudioWorkletNode(ctx, "alignment-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      tapNode.port.onmessage = (e) => {
        if (e.data && e.data.type === "ENERGY") onEnergy(e.data);
      };
      // Zero-gain sink keeps the graph pulling the tap without audible output.
      muteGain = ctx.createGain();
      muteGain.gain.value = 0;
      opts.sourceNode.connect(tapNode);
      tapNode.connect(muteGain);
      muteGain.connect(ctx.destination);
      dbg("attached, tab", boundTabId, "sr", sampleRate);
    } catch (err) {
      console.warn("[KF-ALIGN] attach failed (alignment disabled):", err);
      detach();
    }
  }

  function detach() {
    try { if (tapNode) { tapNode.port.onmessage = null; tapNode.disconnect(); } } catch (e) {}
    try { if (muteGain) muteGain.disconnect(); } catch (e) {}
    tapNode = null;
    muteGain = null;
    ctx = null;
    ring = null;
    clockPairs = [];
    lastTick = null;
    resetSong(null);
  }

  // ---------------------------------------------------------------- energy
  function onEnergy(msg) {
    if (!ring) return;
    const startBlock = Math.round(msg.startSample / msg.blockSize);
    for (let i = 0; i < msg.rms.length; i++) {
      const idx = startBlock + i;
      ring[idx % RING_BLOCKS] = msg.rms[i];
      if (idx > maxBlockIdx) maxBlockIdx = idx;
    }
  }

  function envelopeForCtxRange(ctxA, ctxB) {
    const hop = 512 / sampleRate;
    let a = Math.floor(ctxA / hop);
    let b = Math.ceil(ctxB / hop);
    const minValid = Math.max(0, maxBlockIdx - RING_BLOCKS + 1);
    if (a < minValid || b > maxBlockIdx) return null; // evicted or not yet captured
    const out = new Array(b - a);
    for (let i = a; i < b; i++) out[i - a] = ring[i % RING_BLOCKS];
    return { env: out, startCtxSec: a * hop, hopSec: hop };
  }

  // ------------------------------------------------------------- messaging
  try {
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (!enabled || !ctx) return;
      if (!sender.tab) return; // only content-script traffic
      if (boundTabId != null && sender.tab.id !== boundTabId) return;
      try {
        if (message.type === "PLAYBACK_TIME") onPlaybackTime(message);
        else if (message.type === "LYRICS_STATE") onLyricsState(message.state);
      } catch (err) {
        dbg("handler error", err);
      }
    });
  } catch (e) { /* not in extension context */ }

  function onLyricsState(state) {
    if (!state) return;
    const key = state.cleanedTitle || state.title || "";
    if (key !== songKey) resetSong(key);
    meta = state.primary || meta;
    const parsed = state.parsedLines || [];
    if (parsed.length > 1 && lines.length === 0) {
      lines = parsed.map((l, i) => {
        const next = parsed[i + 1];
        const endSec = Math.min(
          l.time + MAX_LINE_SEC,
          next ? next.time : l.time + MAX_LINE_SEC
        );
        return { startSec: l.time, endSec, text: l.text, done: false };
      });
      dbg("lyrics loaded:", lines.length, "lines for", key);
    }
  }

  function resetSong(key) {
    songKey = key;
    meta = null;
    lines = [];
    spans = [];
    clockPairs = [];
    lastTick = null;
    mediaDuration = 0;
  }

  function onPlaybackTime(msg) {
    const now = ctx.currentTime;
    if (msg.duration > 0) mediaDuration = msg.duration;

    if (msg.paused) {
      lastTick = null;
      return;
    }

    // clock mapping pair
    clockPairs.push({ media: msg.time, ctx: now });
    if (clockPairs.length > MAX_CLOCK_PAIRS) clockPairs.shift();

    // coverage spans (detect seeks/gaps between 200ms ticks)
    if (lastTick && msg.time > lastTick.media && msg.time - lastTick.media < 1.5) {
      spans[spans.length - 1].b = msg.time;
    } else {
      spans.push({ a: msg.time, b: msg.time });
      // a seek invalidates the clock mapping history
      if (lastTick) clockPairs = [{ media: msg.time, ctx: now }];
    }
    lastTick = { media: msg.time, wall: Date.now() };

    maybeAnalyze(msg.time);
  }

  function mediaOffsetSec() {
    if (clockPairs.length < MIN_CLOCK_PAIRS) return null;
    const deltas = clockPairs.map((p) => p.media - p.ctx).sort((a, b) => a - b);
    return deltas[Math.floor(deltas.length / 2)];
  }

  function isCovered(line) {
    return spans.some((s) => s.a <= line.startSec - SPAN_PAD_SEC + 0.01 && s.b >= line.endSec + SPAN_PAD_SEC);
  }

  // ------------------------------------------------------------- analysis
  function maybeAnalyze(mediaNow) {
    if (lines.length === 0 || !meta) return;
    const offset = mediaOffsetSec();
    if (offset === null) return;

    for (const line of lines) {
      if (line.done) continue;
      if (mediaNow < line.endSec + LINE_DONE_MARGIN_SEC) continue;
      if (mediaNow > line.endSec + 30) { line.done = true; continue; } // too old, ring may wrap
      if (!isCovered(line)) continue;
      line.done = true;
      analyzeLine(line, offset);
    }
  }

  function analyzeLine(line, offsetSec) {
    // media time -> context time of the corresponding audio
    const ctxA = line.startSec - offsetSec + CAPTURE_LATENCY_SEC;
    const ctxB = line.endSec - offsetSec + CAPTURE_LATENCY_SEC;
    const slice = envelopeForCtxRange(ctxA, ctxB);
    if (!slice) { dbg("no envelope for line", line.text); return; }

    const det = core.detectOnsets(slice.env, slice.hopSec);
    if (det.onsets.length === 0) { dbg("no onsets:", line.text); return; }

    // onset env-index -> absolute media ms
    const onsetsMs = det.onsets.map((i) => {
      const ctxSec = slice.startCtxSec + i * slice.hopSec;
      return Math.round((ctxSec + offsetSec - CAPTURE_LATENCY_SEC) * 1000);
    });

    const words = line.text.split(/\s+/).filter(Boolean);
    const mapped = core.mapWordsToOnsets({
      words,
      lineStartMs: Math.round(line.startSec * 1000),
      lineEndMs: Math.round(line.endSec * 1000),
      onsetsMs,
    });
    if (!mapped) return;

    const confidence = core.lineConfidence(mapped.matchRatio, det.snr);
    dbg(`line "${line.text}" onsets=${det.onsets.length} conf=${confidence}`);
    if (confidence < MIN_CONFIDENCE) return;

    submitObservation(line, mapped.words, confidence);
  }

  function submitObservation(line, words, confidence) {
    if (!meta || !meta.artistName || !meta.trackName || !mediaDuration) return;
    const body = {
      artist_name: meta.artistName,
      track_name: meta.trackName,
      duration: Math.round(mediaDuration),
      line_start_ms: Math.round(line.startSec * 1000),
      line_text: line.text,
      words,
      confidence,
      client: "karafilt-listen-align/0.1",
    };
    fetch(`${baseUrl}/api/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => dbg("observe →", r.status))
      .catch((err) => dbg("observe failed", err && err.message));
  }

  self.KFAlign = { attach, detach };
})();
