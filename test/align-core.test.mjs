import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../shared/align-core.js");

test("syllableCount: common words", () => {
  assert.equal(core.syllableCount("hello"), 2);
  assert.equal(core.syllableCount("world"), 1);
  assert.equal(core.syllableCount("beautiful"), 3);
  assert.equal(core.syllableCount("time"), 1); // silent e
  assert.equal(core.syllableCount("little"), 2); // -le keeps its syllable
  assert.equal(core.syllableCount("I"), 1);
  assert.equal(core.syllableCount("...")>= 1, true); // punctuation-only never 0
});

function syntheticEnv(len, bumps) {
  // Low noise floor with sharp energy bumps at given indices.
  const env = new Array(len).fill(0.01);
  for (const at of bumps) {
    for (let i = 0; i < 6; i++) {
      if (at + i < len) env[at + i] = Math.max(env[at + i], 0.5 - i * 0.06);
    }
  }
  return env;
}

test("detectOnsets: finds distinct bumps, respects refractory", () => {
  const hop = 512 / 48000; // ~10.7ms
  const env = syntheticEnv(400, [50, 150, 250, 253]); // last two closer than 90ms
  const { onsets, snr } = core.detectOnsets(env, hop);
  assert.equal(onsets.length, 3, `expected 3 onsets, got ${onsets.length} (${onsets})`);
  assert.ok(Math.abs(onsets[0] - 50) <= 3);
  assert.ok(Math.abs(onsets[1] - 150) <= 3);
  assert.ok(snr > 2, `snr should be healthy, got ${snr}`);
});

test("detectOnsets: silence yields nothing", () => {
  const { onsets } = core.detectOnsets(new Array(300).fill(0.005), 512 / 48000);
  assert.equal(onsets.length, 0);
});

test("mapWordsToOnsets: onsets matching syllables land words on them", () => {
  // "hold me now" = 3 syllables, 3 onsets
  const res = core.mapWordsToOnsets({
    words: ["hold", "me", "now"],
    lineStartMs: 10000,
    lineEndMs: 13000,
    onsetsMs: [10050, 10800, 11700],
  });
  assert.ok(res);
  assert.equal(res.words.length, 3);
  assert.equal(res.words[0].start_ms, 10050);
  assert.equal(res.words[1].start_ms, 10800);
  assert.equal(res.words[2].start_ms, 11700);
  // ends chain to next start
  assert.equal(res.words[0].end_ms, 10800);
  assert.equal(res.words[1].end_ms, 11700);
  assert.ok(res.words[2].end_ms > 11700 && res.words[2].end_ms <= 13000);
  assert.equal(res.matchRatio, 1);
});

test("mapWordsToOnsets: onset/syllable mismatch degrades gracefully", () => {
  // 6 syllables, only 3 onsets -> interpolated, monotonic, inside line
  const res = core.mapWordsToOnsets({
    words: ["suddenly", "everything", "stops"],
    lineStartMs: 5000,
    lineEndMs: 9000,
    onsetsMs: [5100, 6500, 7900],
  });
  assert.ok(res);
  const starts = res.words.map((w) => w.start_ms);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1]);
  assert.ok(starts[0] >= 5000 && res.words[2].end_ms <= 9000);
  assert.ok(res.matchRatio < 1);
});

test("mapWordsToOnsets: single onset anchors the line", () => {
  const res = core.mapWordsToOnsets({
    words: ["falling", "away"],
    lineStartMs: 0,
    lineEndMs: 3000,
    onsetsMs: [200],
  });
  assert.ok(res);
  assert.equal(res.words[0].start_ms, 200);
  assert.ok(res.words[1].start_ms > 200);
  assert.ok(res.words[1].end_ms <= 3000);
});

test("mapWordsToOnsets: no usable onsets returns null", () => {
  assert.equal(
    core.mapWordsToOnsets({ words: ["hi"], lineStartMs: 0, lineEndMs: 1000, onsetsMs: [] }),
    null
  );
  // onsets entirely outside the line window are discarded
  assert.equal(
    core.mapWordsToOnsets({ words: ["hi"], lineStartMs: 0, lineEndMs: 1000, onsetsMs: [5000] }),
    null
  );
});

test("lineConfidence combines match ratio and snr", () => {
  assert.ok(core.lineConfidence(1, 10) > core.lineConfidence(1, 1.5));
  assert.ok(core.lineConfidence(1, 5) > core.lineConfidence(0.5, 5));
  assert.ok(core.lineConfidence(1, 6) <= 1);
});
