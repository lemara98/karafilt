// Karafilt — line tokenization tests
//
//   node test/line-tokens.test.mjs
//
// Pure Node (needs Node with Intl.Segmenter — 16+ has it built in).

import assert from "node:assert";
import LT from "../shared/line-tokens.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

const words = (tokens) => tokens.filter((t) => t.isWord).map((t) => t.text);
const joined = (tokens) => tokens.map((t) => t.text).join("");

console.log("line-tokens");

check("Latin line matches the classic whitespace split", () => {
  const toks = LT.lineTokens("Hello world again");
  assert.deepStrictEqual(words(toks), ["Hello", "world", "again"]);
  assert.strictEqual(joined(toks), "Hello world again");
});

check("punctuation stays attached to Latin words, as before", () => {
  const toks = LT.lineTokens("Hello, world!");
  assert.deepStrictEqual(words(toks), ["Hello,", "world!"]);
});

check("measured Latin words map 1:1 with separators preserved", () => {
  const toks = LT.lineTokens("Hello world", ["Hello", "world"]);
  assert.deepStrictEqual(words(toks), ["Hello", "world"]);
  assert.strictEqual(joined(toks), "Hello world");
});

check("measured Chinese char-words each get their own token", () => {
  const text = "月亮代表我的心";
  const chars = [...text];
  const toks = LT.lineTokens(text, chars);
  assert.deepStrictEqual(words(toks), chars);
  assert.strictEqual(joined(toks), text);
});

check("untimed Thai segments into dictionary words, not one blob", () => {
  const toks = LT.lineTokens("เธอคือของขวัญ");
  assert.ok(words(toks).length > 1, `expected >1 word, got ${words(toks).length}`);
  assert.strictEqual(joined(toks), "เธอคือของขวัญ");
});

check("untimed Chinese segments into >1 word", () => {
  const toks = LT.lineTokens("月亮代表我的心");
  assert.ok(words(toks).length > 1);
  assert.strictEqual(joined(toks), "月亮代表我的心");
});

check("mixed Hinglish keeps every script's words", () => {
  const toks = LT.lineTokens("तुम ही हो my love");
  assert.deepStrictEqual(words(toks), ["तुम", "ही", "हो", "my", "love"]);
});

check("unlocatable measured words fall back to segmentation", () => {
  const toks = LT.lineTokens("Completely different text", ["nope", "missing"]);
  assert.deepStrictEqual(words(toks), ["Completely", "different", "text"]);
});

check("empty line yields no tokens", () => {
  assert.deepStrictEqual(LT.lineTokens(""), []);
});

check("locateWordRanges walks matches sequentially", () => {
  const r = LT.locateWordRanges("la la land", ["la", "la", "land"]);
  assert.deepStrictEqual(r, [
    { start: 0, end: 2 },
    { start: 3, end: 5 },
    { start: 6, end: 10 },
  ]);
});

if (failures > 0) {
  console.error(`${failures} failing`);
  process.exit(1);
}
console.log("all line-tokens tests passed");
