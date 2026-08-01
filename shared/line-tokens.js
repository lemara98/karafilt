// Karafilt — lyric line tokenization (shared, pure, DOM-free)
//
// Splits a lyric line into renderable tokens for the karaoke sweep. Latin
// lines keep the classic whitespace split. Scripts written without spaces
// (Thai, Khmer, Lao, Myanmar, Han, kana) can't be split that way — a whole
// line used to become ONE .word span and the sweep lit it all at once.
//
// Two cases:
//   - Measured timing (Enhanced LRC word list): tokens mirror the payload
//     words 1:1, located by character offset in the line text — so Chinese
//     char-per-word payloads sweep per character, and the separators between
//     words are whatever the text actually has (space, comma, nothing).
//   - No timing: whitespace split when the line has none of the unspaced
//     scripts; otherwise Intl.Segmenter's dictionary word segmentation, so
//     the linear estimate sweep moves word-by-word instead of line-at-once.
//
// Loaded like song-match.js: content script, side panel, and Node tests.
// Keep DOM/chrome-free.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.KarafiltLineTokens = api;
})(typeof self !== "undefined" ? self : this, function () {
  // Thai, Lao, Khmer, Myanmar, Han, Hiragana/Katakana — scripts that don't
  // separate words with spaces.
  const UNSPACED_RE = /[฀-๿຀-໿ក-៿က-႟぀-ヿ㐀-䶿一-鿿豈-﫿]/;

  let segmenter = null;
  function getSegmenter() {
    if (segmenter === null && typeof Intl !== "undefined" && Intl.Segmenter) {
      // Locale-less: ICU picks per-script dictionaries (Thai included).
      segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    }
    return segmenter;
  }

  /**
   * Sequentially locate each payload word inside the line text.
   * Returns [{start, end}] (character offsets) or null when the words don't
   * tile the text in order — caller falls back to untimed segmentation.
   */
  function locateWordRanges(text, wordTexts) {
    const ranges = [];
    let cursor = 0;
    for (const w of wordTexts) {
      if (!w) return null;
      const idx = text.indexOf(w, cursor);
      if (idx === -1) return null;
      ranges.push({ start: idx, end: idx + w.length });
      cursor = idx + w.length;
    }
    return ranges;
  }

  /** Untimed tokenization: [{text, isWord}] covering the whole line. */
  function segmentUntimed(text) {
    if (!UNSPACED_RE.test(text)) {
      // Classic path — identical output to the old split(/(\s+)/) rendering.
      const out = [];
      for (const tok of text.split(/(\s+)/)) {
        if (tok) out.push({ text: tok, isWord: !/^\s+$/.test(tok) });
      }
      return out;
    }
    const seg = getSegmenter();
    if (!seg) {
      // Ancient runtime without Intl.Segmenter — old behavior (one span).
      return text ? [{ text, isWord: !/^\s+$/.test(text) }] : [];
    }
    const out = [];
    for (const s of seg.segment(text)) {
      out.push({ text: s.segment, isWord: !!s.isWordLike });
    }
    return out;
  }

  /**
   * Tokens for rendering one line: [{text, isWord}]. With `wordTexts`
   * (measured timing) the word tokens correspond 1:1, in order, to the
   * payload words; anything between them is a non-word separator token.
   */
  function lineTokens(text, wordTexts) {
    if (wordTexts && wordTexts.length > 0) {
      const ranges = locateWordRanges(text, wordTexts);
      if (ranges) {
        const out = [];
        let cursor = 0;
        for (const r of ranges) {
          if (r.start > cursor) out.push({ text: text.slice(cursor, r.start), isWord: false });
          out.push({ text: text.slice(r.start, r.end), isWord: true });
          cursor = r.end;
        }
        if (cursor < text.length) out.push({ text: text.slice(cursor), isWord: false });
        return out;
      }
    }
    return segmentUntimed(text || "");
  }

  return { lineTokens, locateWordRanges, segmentUntimed };
});
