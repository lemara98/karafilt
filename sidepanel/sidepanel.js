// Set to true for verbose console logging during development.
const KF_DEBUG = false;
const dbg = (...args) => { if (KF_DEBUG) console.log(...args); };

const songTitleEl = document.getElementById("song-title");
const sourceBadgeEl = document.getElementById("source-badge");
const statusEl = document.getElementById("status");
const linesEl = document.getElementById("lines");
const googleSearchBtn = document.getElementById("google-search");
const altsBarEl = document.getElementById("alternatives-bar");
const altsToggleEl = document.getElementById("alternatives-toggle");
const altsCountEl = document.getElementById("alternatives-count");
const altsListEl = document.getElementById("alternatives-list");
const refreshBtn = document.getElementById("refresh-lyrics");
const lyricsLoaderEl = document.getElementById("lyrics-loader");

// Status texts that mean "we're actively fetching/processing — show the loader".
// Anything else (e.g. "No lyrics found", source badge text) means we're done.
const LOADING_STATUS_RE = /(loading|looking up|refreshing|searching)/i;

function isLoadingState() {
  if (parsedLines.length > 0 || plainLyrics) return false;
  if (!hasMedia) return false;
  return LOADING_STATUS_RE.test(statusEl.textContent || "");
}

function updateLoaderVisibility() {
  if (!lyricsLoaderEl) return;
  lyricsLoaderEl.style.display = isLoadingState() ? "" : "none";
  if (sourceBadgeEl) {
    sourceBadgeEl.classList.toggle("loading", isLoadingState());
  }
}

let lastCleanedTitle = "";
// Per-song key reported by the content script's site adapter (e.g. Spotify
// "sp:<trackId>"). On such sites the tab URL doesn't change per song, so this
// beats deriveVideoKey(lastKnownUrl) for ratings/usage keying. null elsewhere.
let lastStateVideoKey = null;

// The key everything per-song (ratings, usage reporting) should use.
function currentSongVideoKey() {
  return lastStateVideoKey || deriveVideoKey(lastKnownUrl);
}

googleSearchBtn.addEventListener("click", () => {
  const q = lastCleanedTitle ? `${lastCleanedTitle} lyrics` : "lyrics";
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  chrome.tabs.create({ url });
});

function setGoogleButtonVisible(visible) {
  googleSearchBtn.style.display = visible ? "" : "none";
}

let parsedLines = [];
let plainLyrics = null;
let currentLineIndex = -1;
let activeTabId = null;
let hasMedia = false;

// --- Instrumental-gap loading bar -----------------------------------------
// During silences longer than GAP_MIN_SECONDS (the intro before the first
// line, or breaks between word-timed lines) a progress bar fills across the
// wait instead of the panel sitting frozen. Line ends are only knowable when
// word times exist (LRC lines carry start times only), so plain-LRC songs get
// an intro bar but no mid-song bars.
const GAP_MIN_SECONDS = 5;
const GAP_WORD_TAIL_SECONDS = 1.2;
const gapBarEl = document.getElementById("lyric-gap");
const gapFillEl = document.getElementById("lyric-gap-fill");

function computeLyricGaps(lines) {
  const gaps = [];
  if (!lines || lines.length === 0) return gaps;
  if (lines[0].time > GAP_MIN_SECONDS) {
    gaps.push({ start: 0, end: lines[0].time, nextIndex: 0 });
  }
  for (let i = 0; i < lines.length - 1; i++) {
    const words = lines[i].words;
    if (!words || words.length === 0) continue;
    const lastTime = words[words.length - 1].time;
    if (typeof lastTime !== "number") continue;
    const end = lastTime + GAP_WORD_TAIL_SECONDS;
    if (lines[i + 1].time - end > GAP_MIN_SECONDS) {
      gaps.push({ start: end, end: lines[i + 1].time, nextIndex: i + 1 });
    }
  }
  return gaps;
}

/** In a gap's final second the upcoming line takes the stage early: returns its index, else -1. */
function stagedLineIndex(t) {
  for (const g of lyricGaps()) {
    if (t >= g.end - 1 && t < g.end) return g.nextIndex;
  }
  return -1;
}

// Lazy, identity-cached: parsedLines is reassigned (never mutated in place)
// wherever lyrics change, so a reference check is enough to invalidate.
let lyricGapsCache = { source: null, gaps: [] };
function lyricGaps() {
  if (lyricGapsCache.source !== parsedLines) {
    lyricGapsCache = { source: parsedLines, gaps: computeLyricGaps(parsedLines) };
  }
  return lyricGapsCache.gaps;
}

/** Show/advance/hide the bar for time `t` (seconds). Returns true while in a gap. */
function updateGapBar(t) {
  if (!gapBarEl || !gapFillEl) return false;
  let gap = null;
  for (const g of lyricGaps()) {
    // Hide 1s before the next line lands so the singer gets a clean view.
    if (t >= g.start && t < g.end - 1) { gap = g; break; }
  }
  if (!gap) {
    gapBarEl.classList.remove("visible");
    return false;
  }
  const progress = Math.min(1, Math.max(0, (t - gap.start) / (gap.end - gap.start)));
  gapFillEl.style.transform = `scaleX(${progress})`;
  gapBarEl.classList.add("visible");
  return true;
}
let lastPlaybackTime = 0;
let lastRenderedCount = 0;
let lastRenderedMode = null;  // "synced" | "plain" | null
// Karaoke (focus) view: shows only the active line plus its immediate
// neighbors instead of the full scrolling list. Toggled from the header.
let karaokeMode = false;
// Song duration reported by the content script alongside currentTime. Used
// for the linear scroll on plain (unsynced) lyrics — 0 means unknown
// (e.g. live streams), in which case the auto-scroll is skipped.
let lastPlaybackDuration = 0;
// Full set of matches the LRCLib lookup returned — primary at index 0
// followed by the alternatives. Each entry: {trackName, artistName, source,
// syncedLyrics?, syncedLines?, plainLyrics?}. currentMatchIdx points at the
// match currently rendered in parsedLines/plainLyrics.
let allMatches = [];
let currentMatchIdx = -1;
// Auto-open bookkeeping for the matches picker: the dropdown opens by itself
// once per distinct match list, then closes again after 5s of no interaction
// (keeping the already-rendered default match). altsAutoOpenKey remembers the
// last list we auto-opened for so repeated LYRICS_STATE messages don't re-open
// a picker the user (or the timer) already dismissed. While the timer runs,
// the bar carries .counting, which shows a draining countdown strip (CSS
// animation — its 5s duration must match ALTS_AUTO_CLOSE_MS).
const ALTS_AUTO_CLOSE_MS = 5000;
let altsAutoCloseTimer = null;
let altsAutoOpenKey = "";

function cancelAltsAutoClose() {
  if (altsAutoCloseTimer) {
    clearTimeout(altsAutoCloseTimer);
    altsAutoCloseTimer = null;
  }
  if (altsBarEl) altsBarEl.classList.remove("counting");
}

// --- Title cleaning (shared/song-match.js, loaded before this script) ---
const cleanTitle = (window.KarafiltSongMatch && window.KarafiltSongMatch.cleanTitle)
  || ((s) => (s || "").trim());

// --- Rendering ---
function setStatus(text) {
  if (!text) {
    statusEl.classList.add("hidden");
    statusEl.textContent = "";
  } else {
    statusEl.classList.remove("hidden");
    statusEl.textContent = text;
  }
  updateLoaderVisibility();
}

// The Karalyr K mark (13 lyric-line rects on the family 72x80 grid), used in
// the source badge when word-timed Karalyr lyrics are active. Rows sweep
// top-to-bottom via CSS (.source-badge.karalyr rect).
const KARALYR_K_SVG =
  '<svg viewBox="0 0 72 80" aria-hidden="true">' +
  '<defs><linearGradient id="klrbg" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0%" stop-color="#b46cff"/><stop offset="100%" stop-color="#ff6b9d"/>' +
  "</linearGradient></defs>" +
  '<g fill="url(#klrbg)">' +
  [
    [6, 6, 12], [50, 6, 16], [6, 17, 12], [40, 17, 16], [6, 28, 12], [30, 28, 16],
    [6, 39, 30], [6, 50, 12], [30, 50, 16], [6, 61, 12], [40, 61, 16], [6, 72, 12], [50, 72, 16],
  ]
    .map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="8" rx="2"></rect>`)
    .join("") +
  "</g></svg>";

function setSourceBadge(text, karalyrWordSync) {
  if (!text) {
    sourceBadgeEl.classList.remove("visible", "karalyr");
    sourceBadgeEl.textContent = "";
    return;
  }
  sourceBadgeEl.classList.add("visible");
  if (karalyrWordSync) {
    // Word-timed lyrics from the Karalyr library get the distinctive K badge.
    sourceBadgeEl.classList.add("karalyr");
    sourceBadgeEl.innerHTML = `${KARALYR_K_SVG}<span>karalyr · word-sync</span>`;
  } else {
    sourceBadgeEl.classList.remove("karalyr");
    sourceBadgeEl.textContent = text;
  }
}

// Parse an LRC string into [{time, text}, ...]. Mirrors content/lyrics-overlay.js
// — needed here so the side panel can render an alternative without a content-
// script round-trip.
function parseLRC(lrc) {
  const out = [];
  const lineRe = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  for (const rawLine of (lrc || "").split(/\r?\n/)) {
    let match;
    const timestamps = [];
    lineRe.lastIndex = 0;
    while ((match = lineRe.exec(rawLine)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseFloat(match[2]);
      timestamps.push(minutes * 60 + seconds);
    }
    if (timestamps.length === 0) continue;
    const text = rawLine.replace(/\[[^\]]*\]/g, "").trim();
    if (!text) continue;
    for (const t of timestamps) out.push({ time: t, text });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// Render the full match list (primary + alternatives) as a switchable picker.
// Auto-opens whenever there's more than one match so the user can see what
// else is available without having to click the toggle first. The currently-
// rendered match is marked and not re-clickable.
function renderMatchesPicker() {
  if (!altsBarEl) return;
  if (!allMatches || allMatches.length === 0) {
    altsBarEl.style.display = "none";
    altsBarEl.classList.remove("open");
    altsListEl.innerHTML = "";
    cancelAltsAutoClose();
    altsAutoOpenKey = "";
    return;
  }
  altsBarEl.style.display = "";
  // Auto-open once per distinct match list, then close after 5s unless the
  // user interacts — no response means they're fine with the default match.
  const matchKey = allMatches
    .map((m) => `${m.trackName || ""}|${m.artistName || ""}|${m.source || ""}`)
    .join("~");
  if (allMatches.length > 1 && matchKey !== altsAutoOpenKey) {
    altsAutoOpenKey = matchKey;
    altsBarEl.classList.add("open");
    cancelAltsAutoClose();
    // Restart the CSS countdown animation from full width.
    void altsBarEl.offsetWidth;
    altsBarEl.classList.add("counting");
    altsAutoCloseTimer = setTimeout(() => {
      altsAutoCloseTimer = null;
      altsBarEl.classList.remove("open", "counting");
    }, ALTS_AUTO_CLOSE_MS);
  }
  // Header counter shows alternatives only (excluding the current pick).
  altsCountEl.textContent = String(Math.max(0, allMatches.length - 1));
  altsListEl.innerHTML = "";
  allMatches.forEach((m, i) => {
    const isCurrent = i === currentMatchIdx;
    const isSynced = !!m.syncedLyrics;
    const item = document.createElement("button");
    item.className = "alternative-item"
      + (isSynced ? " synced" : "")
      + (isCurrent ? " current" : "");
    const track = document.createElement("span");
    track.className = "alt-track";
    track.textContent = m.trackName || "(unknown track)";
    const meta = document.createElement("span");
    meta.className = "alt-meta";
    meta.textContent =
      (m.artistName || "(unknown artist)") +
      " · " + (isSynced ? "synced" : "plain") +
      (isCurrent ? " · current" : "");
    item.appendChild(track);
    item.appendChild(meta);
    // Clicking a different match switches to it (switchToMatch also closes the
    // dropdown); clicking the already-selected one just closes the dropdown.
    item.addEventListener("click", () => {
      if (isCurrent) altsBarEl.classList.remove("open");
      else switchToMatch(i);
    });
    altsListEl.appendChild(item);
  });
}

function switchToMatch(index) {
  if (index === currentMatchIdx) return;
  const m = allMatches[index];
  if (!m) return;
  currentMatchIdx = index;

  const isSynced = !!m.syncedLyrics;
  if (m.syncedLyrics) {
    const lines = parseLRC(m.syncedLyrics);
    parsedLines = lines.length > 0 ? lines : [];
    plainLyrics = lines.length > 0 ? null : (m.plainLyrics || null);
  } else if (m.plainLyrics) {
    parsedLines = [];
    plainLyrics = m.plainLyrics;
  } else {
    return;
  }
  lastRenderedMode = null;  // force a clean re-render
  lastRenderedCount = 0;
  renderLines(parsedLines.length > 0 ? "synced" : "plain");

  const sourceLabel = (m.source || "match") + (isSynced ? " (synced)" : " (unsynced)");
  setSourceBadge(sourceLabel);
  setStatus("");
  renderMatchesPicker();
  // Collapse the alternatives dropdown after a manual pick — the user just
  // resolved the picker, so leaving it open obscures the lyrics they wanted.
  if (altsBarEl) altsBarEl.classList.remove("open");
  if (parsedLines.length > 0 && lastPlaybackTime > 0) {
    syncToPlaybackTime(lastPlaybackTime);
  }
}

if (altsToggleEl) {
  altsToggleEl.addEventListener("click", () => {
    cancelAltsAutoClose();
    altsBarEl.classList.toggle("open");
  });
}
// Hovering the open list counts as a response — don't yank it away mid-read.
if (altsListEl) {
  altsListEl.addEventListener("pointerenter", cancelAltsAutoClose);
}

// --- Manual refresh ---
if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.classList.contains("spinning")) return;
    refreshBtn.classList.add("spinning");
    try {
      const tab = await getActiveTab();
      if (!tab) {
        setStatus("No active tab");
        return;
      }
      // Wipe local state immediately so the loader appears.
      parsedLines = [];
      plainLyrics = null;
      allMatches = [];
      currentMatchIdx = -1;
      currentLineIndex = -1;
      lastPlaybackTime = 0;
      aiLagSeconds = 0;
      lastRenderedCount = 0;
      lastRenderedMode = null;
      setSourceBadge("");
      setStatus("Refreshing…");
      setGoogleButtonVisible(false);
      renderMatchesPicker();
      renderLines(null);
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "REFRESH_LYRICS" });
      } catch {
        setStatus("No media on this tab");
      }
    } finally {
      // Clear the spin after a beat — the actual fetch result will arrive
      // via LYRICS_STATE shortly. Worst case it spins for ~1s.
      setTimeout(() => refreshBtn.classList.remove("spinning"), 1200);
    }
  });
}

function makeLineEl(line, index) {
  const div = document.createElement("div");
  div.className = "line";
  div.dir = "auto"; // per-line bidi: RTL scripts (Arabic/Hebrew/…) auto-detected
  div.dataset.index = String(index);
  // Split into word + whitespace tokens so each word can be styled individually
  // for karaoke highlighting. Whitespace stays as plain text nodes so wrapping
  // behaves naturally.
  const tokens = (line.text || "").split(/(\s+)/);
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) {
      div.appendChild(document.createTextNode(tok));
    } else {
      const span = document.createElement("span");
      span.className = "word upcoming";
      span.textContent = tok;
      div.appendChild(span);
    }
  }
  return div;
}

// Tail duration for the very last line (no nextLine.time to bound it).
const LAST_LINE_TAIL_SECONDS = 4;

function updateWordHighlight(t) {
  if (currentLineIndex < 0 || currentLineIndex >= parsedLines.length) return;
  const lineEl = linesEl.querySelector(`.line.active`);
  if (!lineEl) return;
  const words = lineEl.querySelectorAll(".word");
  if (words.length === 0) return;

  const line = parsedLines[currentLineIndex];
  const lineStart = line.time;
  const next = parsedLines[currentLineIndex + 1];
  const lineEnd = next ? next.time : lineStart + LAST_LINE_TAIL_SECONDS;

  // Measured word timing (Enhanced LRC, e.g. Karalyr word-timed revisions):
  // drive the sweep from real per-word times. Requires the parsed word list
  // to match the rendered spans one-to-one; otherwise fall through to the
  // linear estimate below.
  if (line.words && line.words.length === words.length) {
    for (let i = 0; i < words.length; i++) {
      const start = line.words[i].time;
      const end = i + 1 < line.words.length ? line.words[i + 1].time : lineEnd;
      const cls =
        t >= end ? "word sung" : t >= start ? "word singing" : "word upcoming";
      if (words[i].className !== cls) words[i].className = cls;
    }
    return;
  }

  const span = Math.max(0.001, lineEnd - lineStart);
  const progress = Math.max(0, Math.min(1, (t - lineStart) / span));
  // Boundary word index: the word currently being sung.
  // floor(progress * N) gives 0..N. Clamp the "singing" marker to N-1.
  const sungBefore = Math.min(words.length, Math.floor(progress * words.length));

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let cls;
    if (progress >= 1) {
      cls = "word sung";
    } else if (i < sungBefore) {
      cls = "word sung";
    } else if (i === sungBefore) {
      cls = "word singing";
    } else {
      cls = "word upcoming";
    }
    if (w.className !== cls) w.className = cls;
  }
}

function renderLines(mode) {
  // Full wipe + rebuild. Use renderIncremental() for the fast path when
  // we're just appending new lines.
  linesEl.innerHTML = "";
  currentLineIndex = -1;
  lastRenderedCount = 0;
  lastRenderedMode = mode;

  if (parsedLines.length === 0 && !plainLyrics) {
    // While a fetch is in flight, the loader covers this area — don't also
    // print "Play a song to see lyrics" alongside the spinner.
    if (!isLoadingState()) {
      const empty = document.createElement("div");
      empty.className = "lines-empty";
      empty.textContent = hasMedia ? "Play a song to see lyrics" : "No media on this tab";
      linesEl.appendChild(empty);
    }
    updateLoaderVisibility();
    return;
  }

  if (plainLyrics && parsedLines.length === 0) {
    linesEl.classList.add("unsynced");
    for (const line of plainLyrics.split(/\r?\n/)) {
      const div = document.createElement("div");
      div.className = "line";
      div.dir = "auto"; // per-line bidi: RTL scripts (Arabic/Hebrew/…) auto-detected
      div.textContent = line;
      linesEl.appendChild(div);
    }
    return;
  }

  linesEl.classList.remove("unsynced");
  parsedLines.forEach((line, i) => {
    linesEl.appendChild(makeLineEl(line, i));
  });
  lastRenderedCount = parsedLines.length;

  // The freshly-rendered lines don't yet carry the focus-page class.
  // Reset the page tracker so the next applyKaraokePage call always re-marks
  // the visible page (its early-bail would otherwise leave the lines blank).
  karaokeCurrentPage = -1;
  // Immediately apply highlight if we have a known playback time — avoids
  // a flash of unhighlighted state while waiting for the next PLAYBACK_TIME.
  if (lastPlaybackTime > 0) {
    syncToPlaybackTime(lastPlaybackTime);
  } else if (karaokeMode) {
    // No playback time yet — show the first page so focus mode isn't blank
    // while waiting for the song to start.
    applyKaraokePage(-1);
  }
  updateLoaderVisibility();
}

// Append new lines to existing DOM without wiping. Used for DOM-scraper mode
// where lines are added progressively as captions appear.
function renderIncremental() {
  for (let i = lastRenderedCount; i < parsedLines.length; i++) {
    linesEl.appendChild(makeLineEl(parsedLines[i], i));
  }
  lastRenderedCount = parsedLines.length;
  // Newly-appended lines don't have the focus-page class; reapply so they
  // join the visible page if they fall within it.
  if (karaokeMode) {
    karaokeCurrentPage = -1;
    applyKaraokePage(currentLineIndex);
  }
}

let scrollAnimRAF = null;
function smoothScrollLines(targetTop, duration = 600) {
  if (scrollAnimRAF) cancelAnimationFrame(scrollAnimRAF);
  const startTop = linesEl.scrollTop;
  const distance = targetTop - startTop;
  if (Math.abs(distance) < 1) {
    linesEl.scrollTop = targetTop;
    return;
  }
  const startTime = performance.now();
  // ease-in-out quadratic — symmetric: gentle start, gentle settle
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    linesEl.scrollTop = startTop + distance * ease(t);
    if (t < 1) {
      scrollAnimRAF = requestAnimationFrame(step);
    } else {
      scrollAnimRAF = null;
    }
  }
  scrollAnimRAF = requestAnimationFrame(step);
}

// Karaoke (focus) mode shows lyrics in pages of KARAOKE_PAGE_SIZE lines. The
// visible page only swaps when the active line crosses a page boundary, so
// each page stays on screen long enough to read.
const KARAOKE_PAGE_SIZE = 3;
let karaokeCurrentPage = -1;

function applyKaraokePage(index) {
  if (!linesEl) return;
  const safeIndex = index < 0 ? 0 : index;
  const page = Math.floor(safeIndex / KARAOKE_PAGE_SIZE);
  if (page === karaokeCurrentPage) return;
  karaokeCurrentPage = page;
  const pageStart = page * KARAOKE_PAGE_SIZE;
  const pageEnd = pageStart + KARAOKE_PAGE_SIZE;
  for (const el of linesEl.querySelectorAll(".line")) {
    const i = parseInt(el.dataset.index, 10);
    el.classList.toggle("kc-page-current", i >= pageStart && i < pageEnd);
  }
}

function highlightLine(index) {
  if (index === currentLineIndex) return;
  const prev = linesEl.querySelector(".line.active");
  if (prev) prev.classList.remove("active");
  const next = linesEl.querySelector(`.line[data-index="${index}"]`);
  if (next) {
    next.classList.add("active");
    dbg("[KFL-Sidepanel] active line set to", index, "→", next.textContent.slice(0, 60));
    if (karaokeMode) {
      // Karaoke mode: swap the visible 3-line page only at boundaries.
      applyKaraokePage(index);
    } else {
      // List mode: smooth-scroll the active line to vertical center.
      const target = next.offsetTop + next.offsetHeight / 2 - linesEl.clientHeight / 2;
      smoothScrollLines(target);
    }
  } else {
    console.warn("[KFL-Sidepanel] could not find line element for index", index);
  }
  currentLineIndex = index;
}

// Plain-text lyrics have no timing info, so fall back to a linear scroll:
// scrollFraction = currentTime / duration. Drifts when intros/breaks are
// long, but at least the lyrics move in roughly the right direction. Skipped
// when duration is unknown (live streams, ads). Sync toggle controls this
// via the playback-ticker — when Sync is off, PLAYBACK_TIME stops flowing
// and the user can scroll freely.
function autoScrollPlainLyrics(t) {
  if (!plainLyrics || lastPlaybackDuration <= 0) return;
  const maxScroll = linesEl.scrollHeight - linesEl.clientHeight;
  if (maxScroll <= 0) return;
  const fraction = Math.min(1, Math.max(0, t / lastPlaybackDuration));
  linesEl.scrollTop = fraction * maxScroll;
}

let syncLogCount = 0;
function syncToPlaybackTime(t) {
  updateGapBar(t);
  if (parsedLines.length === 0) {
    autoScrollPlainLyrics(t);
    return;
  }
  const adjusted = t;
  // Binary search for the last line with time <= adjusted
  let lo = 0, hi = parsedLines.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (parsedLines[mid].time <= adjusted) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (syncLogCount++ < 5) {
    dbg(
      `[KFL-Sidepanel] sync t=${adjusted.toFixed(2)}s, lines=${parsedLines.length}, ` +
      `firstTime=${parsedLines[0]?.time?.toFixed(2)}, lastTime=${parsedLines[parsedLines.length - 1]?.time?.toFixed(2)}, ` +
      `found=${found}`
    );
  }
  // Gap ending → show the upcoming line ("get ready": lit, words still dim)
  // instead of leaving the previous one active until the beat drops.
  const staged = stagedLineIndex(adjusted);
  if (staged >= 0) {
    highlightLine(staged);
    updateWordHighlight(adjusted);
  } else if (found >= 0) {
    highlightLine(found);
    updateWordHighlight(adjusted);
  }
}

// --- Active tab tracking ---
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function resetDisplay(statusText) {
  parsedLines = [];
  plainLyrics = null;
  if (gapBarEl) gapBarEl.classList.remove("visible");
  allMatches = [];
  currentMatchIdx = -1;
  currentLineIndex = -1;
  hasMedia = false;
  lastPlaybackTime = 0;
  aiLagSeconds = 0;
  lastRenderedCount = 0;
  lastRenderedMode = null;
  songTitleEl.textContent = "—";
  setSourceBadge("");
  setStatus(statusText || "");
  setGoogleButtonVisible(false);
  renderMatchesPicker();
  renderLines(null);
}

// The panel is PINNED to the tab the user invoked Karafilt on — the service
// worker stores boundTabId (storage.session) before opening the panel.
// Falling back to the active tab covers any unforeseen open path.
async function getPinnedTab() {
  try {
    const { boundTabId } = await chrome.storage.session.get({ boundTabId: null });
    if (boundTabId != null) {
      try {
        return await chrome.tabs.get(boundTabId);
      } catch {
        // Tab is gone — fall through to the active tab.
      }
    }
  } catch {}
  return getActiveTab();
}

async function bindToPinnedTab() {
  const tab = await getPinnedTab();
  if (!tab) {
    resetDisplay("No active tab");
    return;
  }
  activeTabId = tab.id;
  lastKnownUrl = tab.url || null;
  resetDisplay("Loading...");
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "REQUEST_LYRICS_STATE" });
  } catch (e) {
    // Content script wasn't injected — common when the tab was open before
    // the extension was enabled or reloaded. Try to inject it on demand,
    // then retry the message.
    if (tab.url && /^https?:/.test(tab.url)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/lyrics-overlay.js"],
        });
        // Give the script a moment to set up its listener before retrying.
        await new Promise((r) => setTimeout(r, 200));
        await chrome.tabs.sendMessage(tab.id, { type: "REQUEST_LYRICS_STATE" });
        return;
      } catch (injectErr) {
        console.warn("[KFL-Sidepanel] on-demand inject failed:", injectErr);
      }
    }
    resetDisplay("No media on this tab");
  }
}

// --- Message handling ---
chrome.runtime.onMessage.addListener((message, sender) => {
  // Only accept messages from the currently-active tab
  if (!sender.tab) return;
  if (activeTabId != null && sender.tab.id !== activeTabId) return;

  if (message.type === "LYRICS_STATE") {
    const state = message.state || {};
    const cleanedTitle = state.cleanedTitle || cleanTitle(state.title || "");
    lastCleanedTitle = cleanedTitle;
    lastStateVideoKey = state.videoKey || null;
    songTitleEl.textContent = cleanedTitle || "—";
    hasMedia = !!state.hasMedia;

    const newParsed = state.parsedLines || [];
    const newPlain = state.plainLyrics || null;
    const incomingAlts = Array.isArray(state.alternatives) ? state.alternatives : [];
    const incomingPrimary = state.primary || null;
    // Build the unified match list. Primary (if any) is index 0, alternatives
    // follow. If the content script didn't supply primary metadata yet (e.g.
    // YouTube DOM-scraped captions), we still seed allMatches with the alts
    // so the user has something to switch *to*.
    if (incomingPrimary) {
      allMatches = [incomingPrimary, ...incomingAlts];
      currentMatchIdx = 0;
    } else {
      allMatches = incomingAlts;
      currentMatchIdx = -1;
    }
    renderMatchesPicker();

    // Detect whether the new state is a superset of the old (just appended lines).
    // DOM-scraper captions update this way. For incremental updates, we avoid a
    // full re-render so the .active class isn't lost every update.
    const isSuperset =
      lastRenderedMode === "synced" &&
      newPlain === null &&
      plainLyrics === null &&
      newParsed.length > parsedLines.length &&
      parsedLines.every((line, i) =>
        newParsed[i] && newParsed[i].text === line.text
      );

    const prevMode = lastRenderedMode;
    const newMode = newParsed.length > 0 ? "synced" : (newPlain ? "plain" : null);

    parsedLines = newParsed;
    plainLyrics = newPlain;

    if (isSuperset && prevMode === "synced") {
      // Fast path: append new lines without wiping existing DOM (preserves .active)
      renderIncremental();
    } else {
      const contentChanged =
        newMode !== prevMode ||
        newParsed.length !== lastRenderedCount ||
        (newPlain !== null) ||
        (newParsed.length > 0 &&
          linesEl.firstElementChild &&
          linesEl.firstElementChild.textContent !==
            (newParsed[0] && newParsed[0].text));
      if (contentChanged) {
        renderLines(newMode);
      }
    }

    // Status line: show the source badge for synced/plain sources,
    // or a message when nothing is loaded yet.
    if (parsedLines.length > 0 || plainLyrics) {
      setStatus("");
      const karalyrWordSync =
        !!(incomingPrimary && incomingPrimary.source === "karalyr") &&
        parsedLines.some((l) => l.words && l.words.length > 0);
      setSourceBadge(state.status || "", karalyrWordSync);
      setGoogleButtonVisible(false);
    } else {
      setSourceBadge("");
      setStatus(state.status || (hasMedia ? "Play a song to see lyrics" : "No media on this tab"));
      // Show Google search button if a "no lyrics found" state and we have a media title
      const isNotFound =
        hasMedia &&
        cleanedTitle &&
        (state.status || "").toLowerCase().includes("no lyrics");
      setGoogleButtonVisible(isNotFound);
    }

    // Re-apply highlight in case the state update shifted things
    if (parsedLines.length > 0 && lastPlaybackTime > 0) {
      syncToPlaybackTime(lastPlaybackTime);
    }

    // Show/refresh the per-song rating widget for the current song.
    updateRatingWidget();
  } else if (message.type === "PLAYBACK_TIME") {
    lastPlaybackTime = message.time;
    lastPlaybackWall = performance.now();
    playbackPaused = !!message.paused;
    if (typeof message.duration === "number") {
      lastPlaybackDuration = message.duration;
    }
    syncToPlaybackTime(message.time);
    trackListenProgress(message.time, playbackPaused);
    // Word-timed lines animate between the 200ms playback ticks via an
    // extrapolated clock, so the word sweep moves smoothly.
    if (!playbackPaused && wordRafId === null) {
      wordRafId = requestAnimationFrame(wordRafTick);
    }
  }
});

// Frame-level interpolation for measured word timing. Runs only while
// playing AND the active line actually has word times; otherwise it stops
// and the next PLAYBACK_TIME tick restarts it if needed.
let lastPlaybackWall = 0;
let playbackPaused = true;
let wordRafId = null;
function wordRafTick() {
  wordRafId = null;
  if (playbackPaused) return;
  const t = lastPlaybackTime + (performance.now() - lastPlaybackWall) / 1000;
  const inGap = updateGapBar(t);
  const line =
    currentLineIndex >= 0 && currentLineIndex < parsedLines.length
      ? parsedLines[currentLineIndex]
      : null;
  if (line && line.words) {
    updateWordHighlight(t);
  } else if (!inGap) {
    // Nothing animating — stop; the next PLAYBACK_TIME tick restarts us.
    return;
  }
  wordRafId = requestAnimationFrame(wordRafTick);
}

// --- Tab change handling ---
// The panel is tab-pinned: Chrome hides it on other tabs and re-shows it when
// the user returns — no active-tab following. On re-show, re-request state in
// case the song changed while the panel was hidden.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    bindToPinnedTab();
    // The user may have signed in/out on karafilt.com while we were hidden.
    refreshAccountStatus();
  }
});

// Compare URLs by origin + pathname (ignore query-string changes for sync)
function isDifferentPath(oldUrl, newUrl) {
  if (!oldUrl || !newUrl) return oldUrl !== newUrl;
  try {
    const a = new URL(oldUrl);
    const b = new URL(newUrl);
    // YouTube changes ?v= param for different videos — treat those as different too
    if (a.hostname.endsWith("youtube.com")) {
      return (
        a.origin + a.pathname !== b.origin + b.pathname ||
        a.searchParams.get("v") !== b.searchParams.get("v")
      );
    }
    return a.origin + a.pathname !== b.origin + b.pathname;
  } catch (e) {
    return oldUrl !== newUrl;
  }
}

let lastKnownUrl = null;

// When the active tab navigates (YouTube → new video, or different URL entirely)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== activeTabId) return;
  if (changeInfo.url && isDifferentPath(lastKnownUrl, changeInfo.url)) {
    lastKnownUrl = changeInfo.url;
    lastStateVideoKey = null; // navigated away — the adapter key is stale
    // Clear immediately so stale lyrics don't linger
    resetDisplay("Loading...");
    // New song → reset the rating widget (a fresh LYRICS_STATE will re-show it).
    updateRatingWidget();
    // Give the page a moment to load the content script, then rebind
    setTimeout(() => {
      if (tabId === activeTabId) bindToPinnedTab();
    }, 500);
  }
});

// Also listen for explicit LYRICS_RESET messages from the content script
// (fired when YouTube SPA-navigates within the same tab)
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab) return;
  if (activeTabId != null && sender.tab.id !== activeTabId) return;
  if (message.type === "LYRICS_RESET") {
    // Song changed: drop the previous song's adapter key so ratings/usage
    // don't briefly attribute to the old track (the next LYRICS_STATE
    // carries the new key).
    lastStateVideoKey = null;
    resetDisplay("Loading...");
  }
});

// --- Highlight toggle ─────────────────────────────────────────────────────
// Lives in the side panel header. Auto-forces ON when the panel opens so the
// content-script ticker is always live whenever the user can see the panel.
const highlightToggle = document.getElementById("highlight-toggle");

function setShowLyrics(value, persist) {
  if (persist) chrome.storage.local.set({ showLyrics: value });
  chrome.runtime.sendMessage({ type: "SET_SHOW_LYRICS", value });
}

if (highlightToggle) {
  highlightToggle.checked = true;
  // Force-on at load — overrides any stale persisted false (debugged in
  // earlier sessions where showLyrics=false silently blocked PLAYBACK_TIME).
  setShowLyrics(true, true);

  highlightToggle.addEventListener("change", () => {
    setShowLyrics(highlightToggle.checked, true);
  });
}

// --- Karaoke (focus) toggle ───────────────────────────────────────────────
// Hides everything except the current line and its immediate neighbors so the
// side panel reads like a karaoke machine instead of a scrolling lyrics list.
const karaokeToggle = document.getElementById("karaoke-toggle");

function applyKaraokeMode(enabled) {
  karaokeMode = !!enabled;
  if (!linesEl) return;
  linesEl.classList.toggle("karaoke-mode", karaokeMode);
  if (karaokeMode) {
    // Initialize the current page based on whatever the active line is.
    karaokeCurrentPage = -1;
    applyKaraokePage(currentLineIndex);
  } else {
    // Drop all page markers and re-center the active line so the user
    // doesn't land mid-scroll from the previous karaoke view.
    karaokeCurrentPage = -1;
    for (const el of linesEl.querySelectorAll(".line.kc-page-current")) {
      el.classList.remove("kc-page-current");
    }
    if (currentLineIndex >= 0) {
      const el = linesEl.querySelector(`.line[data-index="${currentLineIndex}"]`);
      if (el) {
        const target = el.offsetTop + el.offsetHeight / 2 - linesEl.clientHeight / 2;
        smoothScrollLines(target);
      }
    }
  }
}

if (karaokeToggle) {
  chrome.storage.local.get({ karaokeMode: false }, ({ karaokeMode: stored }) => {
    karaokeToggle.checked = !!stored;
    applyKaraokeMode(!!stored);
  });
  karaokeToggle.addEventListener("change", () => {
    chrome.storage.local.set({ karaokeMode: karaokeToggle.checked });
    applyKaraokeMode(karaokeToggle.checked);
  });
}

// --- Lyrics appearance (font family, size, highlight color) ────────────────
// User-tunable look of the lyrics. Applied as CSS variables on #lines and
// persisted in chrome.storage.local. Side panel only — the popup shows no
// lyrics. "Default" font clears the override so the CSS default stack wins.
const FONT_STACKS = {
  default: "",
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Trebuchet MS", "Segoe UI", Verdana, sans-serif',
  mono: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
};
const APPEARANCE_DEFAULTS = {
  lyricsFont: "default",
  lyricsFontScale: 100, // percent of the base size
  lyricsHighlight: "#c084fc",
};

const fontFamilySel = document.getElementById("sp-font-family");
const fontSizeInput = document.getElementById("sp-font-size");
const fontSizeValue = document.getElementById("sp-font-size-value");
const highlightInput = document.getElementById("sp-highlight-color");
const resetSettingsBtn = document.getElementById("sp-reset-settings");

function applyLyricsFont(key) {
  if (!linesEl) return;
  const stack = FONT_STACKS[key] || "";
  if (stack) linesEl.style.setProperty("--lyrics-font-family", stack);
  else linesEl.style.removeProperty("--lyrics-font-family");
}
function applyLyricsScale(pct) {
  const n = Number(pct) || 100;
  if (linesEl) linesEl.style.setProperty("--lyrics-font-scale", String(n / 100));
  if (fontSizeValue) fontSizeValue.textContent = n + "%";
}
function applyLyricsHighlight(color) {
  if (!linesEl) return;
  if (color) linesEl.style.setProperty("--lyrics-highlight", color);
  else linesEl.style.removeProperty("--lyrics-highlight");
}

chrome.storage.local.get(APPEARANCE_DEFAULTS, (s) => {
  if (fontFamilySel) fontFamilySel.value = s.lyricsFont;
  if (fontSizeInput) fontSizeInput.value = s.lyricsFontScale;
  if (highlightInput) highlightInput.value = s.lyricsHighlight;
  applyLyricsFont(s.lyricsFont);
  applyLyricsScale(s.lyricsFontScale);
  applyLyricsHighlight(s.lyricsHighlight);
});

if (fontFamilySel) {
  fontFamilySel.addEventListener("change", () => {
    chrome.storage.local.set({ lyricsFont: fontFamilySel.value });
    applyLyricsFont(fontFamilySel.value);
  });
}
if (fontSizeInput) {
  fontSizeInput.addEventListener("input", () => {
    chrome.storage.local.set({
      lyricsFontScale: parseInt(fontSizeInput.value, 10),
    });
    applyLyricsScale(fontSizeInput.value);
  });
}
if (highlightInput) {
  highlightInput.addEventListener("input", () => {
    chrome.storage.local.set({ lyricsHighlight: highlightInput.value });
    applyLyricsHighlight(highlightInput.value);
  });
}
if (resetSettingsBtn) {
  resetSettingsBtn.addEventListener("click", () => {
    chrome.storage.local.set(APPEARANCE_DEFAULTS);
    if (fontFamilySel) fontFamilySel.value = APPEARANCE_DEFAULTS.lyricsFont;
    if (fontSizeInput) fontSizeInput.value = APPEARANCE_DEFAULTS.lyricsFontScale;
    if (highlightInput) highlightInput.value = APPEARANCE_DEFAULTS.lyricsHighlight;
    applyLyricsFont(APPEARANCE_DEFAULTS.lyricsFont);
    applyLyricsScale(APPEARANCE_DEFAULTS.lyricsFontScale);
    applyLyricsHighlight(APPEARANCE_DEFAULTS.lyricsHighlight);
  });
}

// --- Filter controls (shared with the popup) ──────────────────────────────
const $sp = (id) => document.getElementById(id);
const spToggleBtn = $sp("sp-toggle");
const spStatusEl = $sp("sp-status");

if (spToggleBtn && window.bindKaraokeControls) {
  window.bindKaraokeControls({
    // Start/Stop must target the PINNED tab, not whatever tab is active.
    getTabId: () => activeTabId,
    toggleBtn: spToggleBtn,
    btnLabel: spToggleBtn.querySelector(".btn-label"),
    playIcon: spToggleBtn.querySelector(".play-icon"),
    stopIcon: spToggleBtn.querySelector(".stop-icon"),
    statusEl: spStatusEl,
    statusText: spStatusEl.querySelector(".status-text"),
    modeSelect: $sp("sp-mode"),
    modeHint: $sp("sp-mode-hint"),
    mixSlider: $sp("sp-mix"),
    mixValue: $sp("sp-mix-value"),
    settingsToggle: $sp("sp-settings-toggle"),
    settingsPanel: $sp("sp-settings-panel"),
    countdownOverlay: $sp("sp-countdown-overlay"),
    countdownNumber: $sp("sp-countdown-number"),
    countdownCancelBtn: $sp("sp-countdown-cancel"),
    authGate: $sp("auth-gate"),
    authGateSignIn: $sp("auth-gate-signin"),
  });
}

// --- Account chip (karafilt.com session) ──────────────────────────────────
// The service worker probes GET /api/me with the site's session cookie and
// reports sign-in state. When signed in, the chip links to the account page;
// the full-panel auth gate handles the signed-out case.
const accountChipEl = document.getElementById("sp-account");
const accountAvatarEl = document.getElementById("sp-account-avatar");
const accountEmailEl = document.getElementById("sp-account-email");
// Tracked sign-in state (auto word-sync requests only fire when signed in).
let accountSignedIn = false;

function refreshAccountStatus() {
  if (!accountChipEl) return;
  chrome.runtime.sendMessage({ type: "GET_ACCOUNT_STATUS" }, (acc) => {
    accountSignedIn = !chrome.runtime.lastError && !!(acc && acc.signedIn);
    // A fresh sign-in (ACCOUNT_CHANGED broadcast) re-enables auto word-sync
    // after an earlier 401 blocked it for the session.
    if (accountSignedIn) wordSyncAuthBlocked = false;
    if (chrome.runtime.lastError || !acc || acc.disabled) {
      accountChipEl.style.display = "none";
      return;
    }
    if (acc.signedIn) {
      accountChipEl.style.display = "";
      accountChipEl.classList.remove("signed-out");
      accountChipEl.href = acc.accountUrl || "https://karafilt.com/account";
      accountAvatarEl.textContent = ((acc.email && acc.email[0]) || "?").toUpperCase();
      accountEmailEl.textContent = acc.email || "Account";
    } else {
      // Signed out → the auth gate covers the panel; no chip needed.
      accountChipEl.style.display = "none";
    }
  });
}

// Signed-out clicks route through the service worker so it can bring the
// user BACK to this tab once sign-in completes — a plain link would strand
// them on the website. Signed-in clicks keep normal link behaviour (account
// page is intentional browsing).
if (accountChipEl) {
  accountChipEl.addEventListener("click", (e) => {
    if (!accountChipEl.classList.contains("signed-out")) return;
    e.preventDefault();
    chrome.runtime.sendMessage({
      type: "OPEN_LOGIN",
      loginUrl: accountChipEl.href,
      returnTabId: activeTabId,
    });
  });
}

// Re-check when the Website URL setting changes (chip appears/disappears).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.websiteUrl) refreshAccountStatus();
});

// SW signals sign-in completed (login popup closed). The panel stayed
// visible during the popup flow, so this is the only refresh trigger then.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.tab) return; // only service-worker broadcasts
  if (message.type === "ACCOUNT_CHANGED") refreshAccountStatus();
});

// --- Filter rating (per song) ─────────────────────────────────────────────
// "How well did vocal removal work on this song?" — a 1–5 star rating + an
// optional comment, tied to the current song (a stable video key) and the
// active filter mode. Sent to the website via the service worker; one rating
// per user per song (the backend upserts), so re-rating a song updates it.
const ratingSectionEl = document.getElementById("sp-rating");
const communityRatingEl = document.getElementById("sp-community-rating");
const ratingStarsEl = document.getElementById("sp-rating-stars");
const ratingCommentEl = document.getElementById("sp-rating-comment");
const ratingSubmitEl = document.getElementById("sp-rating-submit");
const ratingStatusEl = document.getElementById("sp-rating-status");
const ratingExpandEl = document.getElementById("sp-rating-expand");
const ratingStarBtns = ratingStarsEl
  ? Array.from(ratingStarsEl.querySelectorAll(".star"))
  : [];

let selectedRating = 0;
let ratingWidgetKey = null; // video key the widget is currently showing

// deriveVideoKey is provided by shared/video-key.js (loaded before this script).
const deriveVideoKey = globalThis.deriveVideoKey;

function paintStars() {
  for (const btn of ratingStarBtns) {
    const v = Number(btn.dataset.value);
    btn.classList.toggle("selected", v <= selectedRating);
  }
  if (ratingSubmitEl) ratingSubmitEl.disabled = selectedRating < 1;
  // Keep it compact until a star is chosen: reveal the comment + submit only
  // once there's a rating (a fresh click, or a pre-filled existing rating).
  if (ratingExpandEl) ratingExpandEl.style.display = selectedRating > 0 ? "" : "none";
}

function resetRatingWidget() {
  selectedRating = 0;
  if (ratingCommentEl) ratingCommentEl.value = "";
  if (ratingStatusEl) {
    ratingStatusEl.textContent = "";
    ratingStatusEl.className = "hint";
  }
  paintStars();
}

// Render a 0–5 average as filled/empty stars (rounded to nearest whole star).
function starString(avg) {
  const n = Math.max(0, Math.min(5, Math.round(avg)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

// Fetch and show the community average for a video key. Always shows the count
// (even for 1 rating); shows a "be the first" prompt when there are none.
function loadCommunityRating(key) {
  if (!communityRatingEl) return;
  communityRatingEl.textContent = "";
  communityRatingEl.className = "community-rating";
  chrome.runtime.sendMessage(
    { type: "GET_FILTER_RATING_STATS", keys: [key] },
    (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) return;
      // Guard against a stale response after the song already changed.
      if (key !== ratingWidgetKey) return;
      const stat = res.stats && res.stats[key];
      if (stat && stat.count > 0) {
        communityRatingEl.innerHTML =
          `<span class="cr-stars">${starString(stat.avg)}</span>` +
          `<span>${stat.avg.toFixed(1)}</span>` +
          `<span class="cr-count">· ${stat.count} ` +
          `rating${stat.count === 1 ? "" : "s"}</span>`;
      } else {
        communityRatingEl.classList.add("cr-empty");
        communityRatingEl.textContent = "No ratings yet — be the first.";
      }
    },
  );
}

// Fetch the signed-in user's existing (active) rating for a video key and
// pre-fill the widget, so they can see and update it rather than rating blind.
// Silent when not signed in or not yet rated (the widget stays in its reset
// state). Guards against a stale response after the song already changed.
function loadMyRating(key) {
  chrome.runtime.sendMessage(
    { type: "GET_MY_FILTER_RATING", videoKey: key },
    (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) return;
      if (key !== ratingWidgetKey) return;
      if (!res.rating) return; // not rated yet — leave the reset widget as-is
      selectedRating = Number(res.rating) || 0;
      if (ratingCommentEl) ratingCommentEl.value = res.comment || "";
      paintStars();
      if (ratingStatusEl) {
        ratingStatusEl.textContent = `You rated this ${starString(
          selectedRating,
        )} — submit to update.`;
        ratingStatusEl.className = "hint";
      }
    },
  );
}

// Show the widget when a song is playing; reset it when the song changes, then
// pre-fill the user's prior rating (if any) so they edit rather than re-rate.
// Tell the service worker which song is playing. The SW times filter usage but
// only sees the tab URL — this gives it the title/artist to label segments with.
// Cheap and idempotent: the SW keys by videoKey and enriches the open segment.
function reportCurrentSong() {
  const videoKey = currentSongVideoKey();
  if (!videoKey) return;
  const match = currentMatchIdx >= 0 ? allMatches[currentMatchIdx] : null;
  chrome.runtime
    .sendMessage({
      type: "SET_CURRENT_SONG",
      song: {
        videoKey,
        videoUrl: lastKnownUrl || null,
        songTitle: lastCleanedTitle || null,
        trackName: (match && match.trackName) || null,
        artistName: (match && match.artistName) || null,
      },
    })
    .catch(() => {});
}

function updateRatingWidget() {
  if (!ratingSectionEl) return;
  const key = hasMedia ? currentSongVideoKey() : null;
  if (!key) {
    ratingSectionEl.style.display = "none";
    ratingWidgetKey = null;
    return;
  }
  ratingSectionEl.style.display = "";
  if (key !== ratingWidgetKey) {
    ratingWidgetKey = key;
    resetRatingWidget();
    loadCommunityRating(key);
    loadMyRating(key);
  }
  reportCurrentSong();
}

for (const btn of ratingStarBtns) {
  btn.addEventListener("click", () => {
    selectedRating = Number(btn.dataset.value) || 0;
    paintStars();
  });
}

if (ratingSubmitEl) {
  ratingSubmitEl.addEventListener("click", () => {
    if (selectedRating < 1) return;
    const match = currentMatchIdx >= 0 ? allMatches[currentMatchIdx] : null;
    const modeSel = document.getElementById("sp-mode");
    const payload = {
      videoKey: currentSongVideoKey(),
      videoUrl: lastKnownUrl || null,
      songTitle: lastCleanedTitle || null,
      trackName: (match && match.trackName) || null,
      artistName: (match && match.artistName) || null,
      filterMode: (modeSel && modeSel.value) || null,
      rating: selectedRating,
      comment: (ratingCommentEl && ratingCommentEl.value.trim()) || null,
      extensionVersion: chrome.runtime.getManifest().version,
    };
    if (!payload.videoKey) return;

    ratingSubmitEl.disabled = true;
    ratingStatusEl.textContent = "Submitting…";
    ratingStatusEl.className = "hint";
    chrome.runtime.sendMessage(
      { type: "SUBMIT_FILTER_RATING", rating: payload },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          ratingStatusEl.textContent =
            res && res.status === 401
              ? "Please sign in to rate."
              : "Couldn't submit — try again.";
          ratingStatusEl.className = "hint err";
          ratingSubmitEl.disabled = false;
          return;
        }
        ratingStatusEl.textContent = "Rating saved — thanks!";
        ratingStatusEl.className = "hint ok";
        // Reflect the new rating in the community average. selectedRating is
        // kept so the stars stay filled, ready for a further edit.
        if (payload.videoKey) loadCommunityRating(payload.videoKey);
      },
    );
  });
}

// --- Party mode (header pill) ──────────────────────────────────────────────
// A compact button next to the logo. Click → the service worker creates a room
// (POST /api/party/create) and opens the host player tab, which carries the QR,
// queue and controls — so there's no QR in the panel. While a party is live the
// pill is highlighted and shows the queue count; clicking again re-opens the
// player tab.
(function initPartyMode() {
  const btn = document.getElementById("sp-party-btn");
  if (!btn) return;
  const countEl = document.getElementById("sp-party-count");

  let current = null; // { code, joinUrl, hostTabId }
  let pollTimer = null;

  const playerUrl = (u) => u + (u.includes("?") ? "&" : "?") + "host=1";

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function refreshCount() {
    if (!current) return;
    chrome.runtime.sendMessage({ type: "GET_PARTY_COUNT", code: current.code }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) return;
      if (res.found === false || res.status === "closed") {
        chrome.runtime.sendMessage({ type: "END_PARTY" }, () => setInactive());
        return;
      }
      if (countEl) {
        const n = res.count ?? 0;
        countEl.textContent = String(n);
        countEl.hidden = n <= 0;
      }
    });
  }
  function setActive(room) {
    current = room;
    btn.classList.add("active");
    btn.title = "Party live — open the player tab";
    refreshCount();
    stopPolling();
    pollTimer = setInterval(refreshCount, 15000);
  }
  function setInactive() {
    current = null;
    stopPolling();
    btn.classList.remove("active");
    btn.title = "Party mode — host a karaoke party";
    if (countEl) { countEl.hidden = true; countEl.textContent = "0"; }
  }
  function openHost() {
    if (!current) return;
    if (current.hostTabId != null) {
      chrome.tabs.update(current.hostTabId, { active: true }).catch(() => {
        chrome.tabs.create({ url: playerUrl(current.joinUrl) });
      });
    } else {
      chrome.tabs.create({ url: playerUrl(current.joinUrl) });
    }
  }

  btn.addEventListener("click", () => {
    if (current) { openHost(); return; } // already live → re-open the player tab
    btn.disabled = true;
    chrome.runtime.sendMessage({ type: "CREATE_PARTY" }, (res) => {
      btn.disabled = false;
      if (chrome.runtime.lastError || !res || !res.ok) {
        btn.title = res && res.status === 401 ? "Please sign in first" : "Couldn't start a party";
        return;
      }
      setActive({ code: res.code, joinUrl: res.joinUrl, hostTabId: res.hostTabId });
    });
  });

  // Restore an in-progress party when the panel (re)opens.
  chrome.runtime.sendMessage({ type: "GET_PARTY" }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.partyRoom && res.partyRoom.code) setActive(res.partyRoom);
  });
})();

// --- Auto word-sync request ────────────────────────────────────────────────
// When a signed-in user has actually listened to a chunk of a song whose
// lyrics were found but carry no word timing yet, silently submit
// {lyrics + video URL + metadata} to the website (QUEUE_WORD_SYNC → the SW
// posts /api/sync-queue), which queues it for alignment. Entirely passive:
// no button, just a small "requested ✓" hint on success.
const SYNC_QUEUE_CACHE_KEY = "syncQueueSubmitted";
const SYNC_QUEUE_CACHE_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
// How long a cached outcome suppresses re-submission (checked at read time).
// Infinity = permanent. Outcomes missing here (upstream, unavailable,
// queue_full, in_flight) are transient and never cached — retry another day.
const SYNC_QUEUE_TTL_MS = {
  already_synced: Infinity,
  queued: 30 * DAY_MS,
  already_queued: 30 * DAY_MS,
  recently_failed: 7 * DAY_MS,
  bad_lyrics: 7 * DAY_MS,
  unsupported_source: 7 * DAY_MS,
  bad_request: 7 * DAY_MS, // deterministic validation reject — don't re-post
  rate_limited: 1 * DAY_MS,
};
const listenSecondsByKey = new Map(); // videoKey → seconds actually listened
const sessionAttempted = new Set();   // videoKeys already tried this session
let autoQueueWordSync = true;         // cached settings toggle
let wordSyncAuthBlocked = false;      // saw a 401 — stop trying this session
let syncQueueSubmittedCache = null;   // storage mirror; null until loaded
let lastListenKey = null;             // accumulation cursor: song + last time
let lastListenTime = 0;

chrome.storage.local.get({ [SYNC_QUEUE_CACHE_KEY]: {} }, (s) => {
  syncQueueSubmittedCache = s[SYNC_QUEUE_CACHE_KEY] || {};
});

// Settings toggle — same load/persist pattern as the karaoke (Focus) toggle.
const autoSyncToggle = document.getElementById("autosync-toggle");
if (autoSyncToggle) {
  chrome.storage.local.get({ autoQueueWordSync: true }, ({ autoQueueWordSync: stored }) => {
    autoSyncToggle.checked = !!stored;
    autoQueueWordSync = !!stored;
  });
  autoSyncToggle.addEventListener("change", () => {
    chrome.storage.local.set({ autoQueueWordSync: autoSyncToggle.checked });
    autoQueueWordSync = autoSyncToggle.checked;
  });
}

// Called from the PLAYBACK_TIME handler (~5 ticks/s). Accumulates listened
// time from the reported-time delta — exact during normal playback, and the
// 2s cap swallows seeks/jumps so skipping around can't fake a full listen.
function trackListenProgress(t, paused) {
  const key = currentSongVideoKey();
  if (!key) return;
  if (key !== lastListenKey) {
    lastListenKey = key;
    lastListenTime = t;
    return;
  }
  const delta = t - lastListenTime;
  lastListenTime = t;
  if (paused || delta <= 0) return;
  const secs = (listenSecondsByKey.get(key) || 0) + Math.min(delta, 2);
  listenSecondsByKey.set(key, secs);
  maybeQueueWordSync(key, secs);
}

function maybeQueueWordSync(key, secs) {
  // Cheap early-outs, roughly cheapest-first.
  if (!autoQueueWordSync || wordSyncAuthBlocked || !accountSignedIn) return;
  // Any source Karalyr can key on. This used to be yt: only, because the
  // aligner fetched the audio with yt-dlp; it no longer fetches anything, so
  // Spotify listening should feed the queue too. A request is just demand —
  // how the audio is eventually obtained is decided per song, later.
  if (!key.startsWith("yt:") && !key.startsWith("sp:")) return;
  if (!syncQueueSubmittedCache) return; // storage not loaded yet
  if (sessionAttempted.has(key)) return;
  const m = currentMatchIdx >= 0 ? allMatches[currentMatchIdx] : null;
  if (!m || (!m.syncedLyrics && !m.plainLyrics) || m.wordTimed) return;
  // The queue needs a track identity; some sources (lyrics.ovh) may lack one.
  if (!m.trackName || !m.artistName) return;
  // Word timing can also show up as parsed Enhanced-LRC word arrays (same
  // signal the karalyr badge uses) — nothing to request then either.
  if (parsedLines.some((l) => l.words && l.words.length > 0)) return;
  const dur = lastPlaybackDuration;
  const threshold = dur > 0 ? Math.min(90, Math.max(45, dur * 0.25)) : 60;
  if (secs < threshold) return;
  const cached = syncQueueSubmittedCache[key];
  if (cached && cached.t) {
    const ttl = SYNC_QUEUE_TTL_MS[cached.r];
    if (ttl === Infinity || (ttl && Date.now() - cached.t < ttl)) return;
  }
  sessionAttempted.add(key);
  chrome.runtime.sendMessage(
    {
      type: "QUEUE_WORD_SYNC",
      request: {
        videoKey: key,
        videoUrl: lastKnownUrl || null,
        trackName: m.trackName || null,
        artistName: m.artistName || null,
        songTitle: lastCleanedTitle || null,
        duration: dur > 0 ? dur : null,
        syncedLyrics: m.syncedLyrics || null,
        plainLyrics: m.plainLyrics || null,
      },
    },
    (res) => {
      if (chrome.runtime.lastError || !res) return;
      handleWordSyncResponse(key, res);
    },
  );
}

function handleWordSyncResponse(key, res) {
  const outcome = res.ok ? "queued" : res.reason || "upstream";
  if (outcome === "unauthenticated") {
    // Don't cache — stop trying until the account status says signed-in
    // again (refreshAccountStatus clears the block). Forget the attempt so
    // this song retries after the user signs in.
    wordSyncAuthBlocked = true;
    sessionAttempted.delete(key);
    return;
  }
  if (res.ok) showWordSyncHint();
  if (!(outcome in SYNC_QUEUE_TTL_MS)) return; // transient — not cached
  rememberSyncOutcome(key, outcome);
}

function rememberSyncOutcome(key, outcome) {
  if (!syncQueueSubmittedCache) syncQueueSubmittedCache = {};
  syncQueueSubmittedCache[key] = { t: Date.now(), r: outcome };
  // Keep only the newest entries so the object can't grow unbounded.
  const keys = Object.keys(syncQueueSubmittedCache);
  if (keys.length > SYNC_QUEUE_CACHE_MAX) {
    keys.sort(
      (a, b) =>
        (syncQueueSubmittedCache[a].t || 0) - (syncQueueSubmittedCache[b].t || 0),
    );
    for (const k of keys.slice(0, keys.length - SYNC_QUEUE_CACHE_MAX)) {
      delete syncQueueSubmittedCache[k];
    }
  }
  chrome.storage.local.set({ [SYNC_QUEUE_CACHE_KEY]: syncQueueSubmittedCache });
}

// Transient "Word-sync requested ✓" hint next to the source badge.
const wordSyncHintEl = document.getElementById("wordsync-hint");
let wordSyncHintTimer = null;
function showWordSyncHint() {
  if (!wordSyncHintEl) return;
  wordSyncHintEl.hidden = false;
  requestAnimationFrame(() => wordSyncHintEl.classList.add("visible"));
  if (wordSyncHintTimer) clearTimeout(wordSyncHintTimer);
  wordSyncHintTimer = setTimeout(() => {
    wordSyncHintTimer = null;
    wordSyncHintEl.classList.remove("visible");
    setTimeout(() => { wordSyncHintEl.hidden = true; }, 350);
  }, 4000);
}

// --- Init ---
bindToPinnedTab();
refreshAccountStatus();
