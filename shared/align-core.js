// Pure signal/text helpers for the listen-along lyrics aligner. No Chrome
// APIs, no DOM — usable from the offscreen page and from node --test.
(function (root) {
  "use strict";

  // --- Syllables ---------------------------------------------------------
  // Heuristic English-ish syllable count: vowel groups, minus a silent
  // trailing "e" (kept for -le endings), never below 1. Good enough for
  // distributing onsets across a lyric line.
  function syllableCount(word) {
    const w = String(word).toLowerCase().replace(/[^a-zà-öø-ÿ]/g, "");
    if (w.length === 0) return 1;
    const groups = w.match(/[aeiouyà-öø-ÿ]+/g);
    let n = groups ? groups.length : 1;
    if (n > 1 && /e$/.test(w) && !/le$/.test(w)) n--;
    return Math.max(1, n);
  }

  // --- Onset detection ---------------------------------------------------
  // env: RMS envelope (one value per hop). Returns onset indices (into env)
  // plus an SNR-ish quality figure. Peak-picking on the positive energy
  // derivative with an adaptive threshold and a refractory period.
  function detectOnsets(env, hopSec, opts) {
    const o = opts || {};
    const refractorySec = o.refractorySec != null ? o.refractorySec : 0.09;
    if (!env || env.length < 8) return { onsets: [], snr: 0 };

    // 3-tap smoothing
    const sm = new Array(env.length);
    for (let i = 0; i < env.length; i++) {
      const a = env[Math.max(0, i - 1)];
      const b = env[i];
      const c = env[Math.min(env.length - 1, i + 1)];
      sm[i] = (a + b + c) / 3;
    }

    const sorted = [...sm].sort((x, y) => x - y);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const floor = pct(0.2);
    // Peak reference is the max (post-smoothing): percentile-based peaks
    // collapse to the floor when singing is sparse within the window.
    const peakRef = sorted[sorted.length - 1];
    const snr = (peakRef + 1e-9) / (floor + 1e-9);

    // positive derivative
    const diff = new Array(sm.length).fill(0);
    let diffSum = 0;
    for (let i = 1; i < sm.length; i++) {
      diff[i] = Math.max(0, sm[i] - sm[i - 1]);
      diffSum += diff[i];
    }
    const meanDiff = diffSum / Math.max(1, sm.length - 1);
    const thr = Math.max(meanDiff * 2, 0.04 * (peakRef - floor));
    const minEnergy = floor + 0.25 * (peakRef - floor);
    const refractory = Math.max(1, Math.round(refractorySec / hopSec));

    const onsets = [];
    let last = -refractory;
    for (let i = 1; i < sm.length - 1; i++) {
      if (
        diff[i] > thr &&
        diff[i] >= diff[i - 1] &&
        diff[i] >= diff[i + 1] &&
        sm[Math.min(sm.length - 1, i + 1)] > minEnergy &&
        i - last >= refractory
      ) {
        onsets.push(i);
        last = i;
      }
    }
    return { onsets, snr };
  }

  // --- Words <- onsets ---------------------------------------------------
  // Distribute a line's words over detected onsets. Word starts are placed
  // by mapping each word's cumulative-syllable fraction onto the onset
  // sequence (interpolated), so extra or missing onsets degrade gracefully.
  // Returns null when there is nothing usable.
  function mapWordsToOnsets(params) {
    const words = params.words;
    const lineStartMs = params.lineStartMs;
    const lineEndMs = params.lineEndMs;
    let onsetsMs = (params.onsetsMs || [])
      .filter((t) => t >= lineStartMs - 150 && t <= lineEndMs)
      .sort((a, b) => a - b);
    if (!words || words.length === 0 || onsetsMs.length === 0) return null;

    const syls = words.map(syllableCount);
    const total = syls.reduce((a, b) => a + b, 0);
    const N = onsetsMs.length;

    // cumulative syllable index -> time along the onset sequence. When the
    // counts match, syllable k lands exactly on onset k; otherwise the
    // sequence is stretched/compressed linearly.
    const denom = Math.max(1, total - 1);
    const timeAt = (cumSyl) => {
      const f = cumSyl / denom;
      if (N === 1) {
        // single anchor: spread from it toward the line end
        const span = Math.max(400, lineEndMs - onsetsMs[0] - 200);
        return onsetsMs[0] + f * span;
      }
      const pos = f * (N - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(N - 1, lo + 1);
      return onsetsMs[lo] + (pos - lo) * (onsetsMs[hi] - onsetsMs[lo]);
    };

    const avgSylMs = N >= 2 ? (onsetsMs[N - 1] - onsetsMs[0]) / denom : 250;

    let cum = 0;
    const starts = words.map((_, i) => {
      const t = timeAt(cum);
      cum += syls[i];
      return t;
    });
    // enforce monotonicity
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] < starts[i - 1] + 10) starts[i] = starts[i - 1] + 10;
    }

    const lastEnd = Math.min(
      lineEndMs,
      Math.max(
        starts[starts.length - 1] + 120,
        timeAt(denom) + avgSylMs * syls[syls.length - 1]
      )
    );
    const out = words.map((text, i) => ({
      text,
      start_ms: Math.round(starts[i]),
      end_ms: Math.round(i + 1 < starts.length ? starts[i + 1] : lastEnd),
    }));
    for (const w of out) {
      if (w.end_ms <= w.start_ms) w.end_ms = w.start_ms + 10;
    }

    // How well the onset count matched the syllable count.
    const ratio = Math.min(N, total) / Math.max(N, total);
    return { words: out, matchRatio: ratio };
  }

  // Overall confidence for a line observation.
  function lineConfidence(matchRatio, snr) {
    const snrFactor = Math.max(0, Math.min(1, (snr - 1.5) / 3));
    return Math.round(matchRatio * (0.5 + 0.5 * snrFactor) * 100) / 100;
  }

  const api = { syllableCount, detectOnsets, mapWordsToOnsets, lineConfidence };
  root.KFAlignCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
