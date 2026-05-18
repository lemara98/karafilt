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
const LOADING_STATUS_RE = /(loading|looking up|refreshing|aligning|searching)/i;

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
let lastPlaybackTime = 0;
// Seconds the AI/server-mode audio lags the original video. The offscreen doc
// measures it and reports it via AI_LAG; we shift the lyric highlight back by
// this much so lyrics line up with the delayed backend audio. 0 in all other
// modes (and when the AI queue drains back to the real-time STFT preview).
let aiLagSeconds = 0;
let lastRenderedCount = 0;
let lastRenderedMode = null;  // "synced" | "plain" | null
// Full set of matches the LRCLib lookup returned — primary at index 0
// followed by the alternatives. Each entry: {trackName, artistName, source,
// syncedLyrics?, syncedLines?, plainLyrics?}. currentMatchIdx points at the
// match currently rendered in parsedLines/plainLyrics.
let allMatches = [];
let currentMatchIdx = -1;

// --- Title cleaning (kept in sync with content script) ---
const SUFFIX_PATTERNS = [
  /\s*\(official[^)]*\)/i,
  /\s*\[official[^\]]*\]/i,
  /\s*\(lyrics?[^)]*\)/i,
  /\s*\[lyrics?[^\]]*\]/i,
  /\s*\(audio\)/i,
  /\s*\(hd\)/i,
  /\s*\(4k\)/i,
  /\s*\(remaster(ed)?[^)]*\)/i,
  /\s*\(live[^)]*\)/i,
  /\s*\(feat\.?[^)]*\)/i,
  /\s*ft\.?\s+.+$/i,
  /\s*\(\d{4}[^)]*\)/,
  /\s*\| spotify$/i,
  /\s*- youtube$/i,
  /\s*- soundcloud$/i,
];

function cleanTitle(s) {
  let out = s || "";
  for (const re of SUFFIX_PATTERNS) out = out.replace(re, "");
  return out.trim();
}

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

function setSourceBadge(text) {
  if (!text) {
    sourceBadgeEl.classList.remove("visible");
    sourceBadgeEl.textContent = "";
  } else {
    sourceBadgeEl.classList.add("visible");
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
    return;
  }
  altsBarEl.style.display = "";
  // Auto-open whenever there are alternatives to switch to.
  if (allMatches.length > 1) altsBarEl.classList.add("open");
  // Header counter shows alternatives only (excluding the current pick).
  altsCountEl.textContent = String(Math.max(0, allMatches.length - 1));
  altsListEl.innerHTML = "";
  allMatches.forEach((m, i) => {
    const isCurrent = i === currentMatchIdx;
    const isSynced = !!(m.syncedLyrics || (Array.isArray(m.syncedLines) && m.syncedLines.length > 0));
    const item = document.createElement("button");
    item.className = "alternative-item"
      + (isSynced ? " synced" : "")
      + (isCurrent ? " current" : "");
    if (isCurrent) item.disabled = true;
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
    if (!isCurrent) {
      item.addEventListener("click", () => switchToMatch(i));
    }
    altsListEl.appendChild(item);
  });
}

function switchToMatch(index) {
  if (index === currentMatchIdx) return;
  const m = allMatches[index];
  if (!m) return;
  currentMatchIdx = index;

  const isSynced = !!(m.syncedLyrics || (Array.isArray(m.syncedLines) && m.syncedLines.length > 0));
  if (Array.isArray(m.syncedLines) && m.syncedLines.length > 0) {
    parsedLines = m.syncedLines;
    plainLyrics = null;
  } else if (m.syncedLyrics) {
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
  if (parsedLines.length > 0 && lastPlaybackTime > 0) {
    syncToPlaybackTime(lastPlaybackTime);
  }
}

if (altsToggleEl) {
  altsToggleEl.addEventListener("click", () => {
    altsBarEl.classList.toggle("open");
  });
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

  const lineStart = parsedLines[currentLineIndex].time;
  const next = parsedLines[currentLineIndex + 1];
  const lineEnd = next ? next.time : lineStart + LAST_LINE_TAIL_SECONDS;
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

  // Immediately apply highlight if we have a known playback time — avoids
  // a flash of unhighlighted state while waiting for the next PLAYBACK_TIME.
  if (lastPlaybackTime > 0) syncToPlaybackTime(lastPlaybackTime);
  updateLoaderVisibility();
}

// Append new lines to existing DOM without wiping. Used for DOM-scraper mode
// where lines are added progressively as captions appear.
function renderIncremental() {
  for (let i = lastRenderedCount; i < parsedLines.length; i++) {
    linesEl.appendChild(makeLineEl(parsedLines[i], i));
  }
  lastRenderedCount = parsedLines.length;
}

function highlightLine(index) {
  if (index === currentLineIndex) return;
  const prev = linesEl.querySelector(".line.active");
  if (prev) prev.classList.remove("active");
  const next = linesEl.querySelector(`.line[data-index="${index}"]`);
  if (next) {
    next.classList.add("active");
    console.log("[KFL-Sidepanel] active line set to", index, "→", next.textContent.slice(0, 60));
    // Manually center the active line inside .lines (scrollIntoView can affect
    // ancestors and behaves unpredictably with rapid updates).
    const target = next.offsetTop + next.offsetHeight / 2 - linesEl.clientHeight / 2;
    linesEl.scrollTo({ top: target, behavior: "smooth" });
  } else {
    console.warn("[KFL-Sidepanel] could not find line element for index", index);
  }
  currentLineIndex = index;
}

let syncLogCount = 0;
function syncToPlaybackTime(t) {
  if (parsedLines.length === 0) {
    if (syncLogCount++ < 3) console.log("[KFL-Sidepanel] sync skipped — no lines yet");
    return;
  }
  // Shift the highlight back by the AI playback lag so lyrics match the
  // delayed backend audio. aiLagSeconds is 0 in non-AI modes, so this is a
  // no-op there.
  const adjusted = t - aiLagSeconds;
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
    console.log(
      `[KFL-Sidepanel] sync t=${adjusted.toFixed(2)}s (raw=${t.toFixed(2)}, lag=${aiLagSeconds.toFixed(2)}), lines=${parsedLines.length}, ` +
      `firstTime=${parsedLines[0]?.time?.toFixed(2)}, lastTime=${parsedLines[parsedLines.length - 1]?.time?.toFixed(2)}, ` +
      `found=${found}`
    );
  }
  if (found >= 0) {
    highlightLine(found);
    updateWordHighlight(adjusted);
  }
}

// AI playback-lag update from the offscreen doc (via SW re-broadcast →
// controls-bindings.js). Re-runs the sync immediately so the highlight shifts
// without waiting for the next PLAYBACK_TIME tick.
window.onAILagUpdate = (lag) => {
  const next = (typeof lag === "number" && isFinite(lag) && lag >= 0) ? lag : 0;
  if (next === aiLagSeconds) return;
  aiLagSeconds = next;
  if (parsedLines.length > 0 && lastPlaybackTime > 0) {
    syncToPlaybackTime(lastPlaybackTime);
  }
};

// --- Active tab tracking ---
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function resetDisplay(statusText) {
  parsedLines = [];
  plainLyrics = null;
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

async function bindToActiveTab() {
  const tab = await getActiveTab();
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
    // Content script not injected on this URL (e.g. chrome:// pages)
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
      setSourceBadge(state.status || "");
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
  } else if (message.type === "PLAYBACK_TIME") {
    lastPlaybackTime = message.time;
    syncToPlaybackTime(message.time);
  }
});

// --- Tab change handling ---
chrome.tabs.onActivated.addListener(() => {
  bindToActiveTab();
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
    // Clear immediately so stale lyrics don't linger
    resetDisplay("Loading...");
    // Give the page a moment to load the content script, then rebind
    setTimeout(() => {
      if (tabId === activeTabId) bindToActiveTab();
    }, 500);
  }
});

// Also listen for explicit LYRICS_RESET messages from the content script
// (fired when YouTube SPA-navigates within the same tab)
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab) return;
  if (activeTabId != null && sender.tab.id !== activeTabId) return;
  if (message.type === "LYRICS_RESET") {
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

// --- Filter controls (shared with the popup) ──────────────────────────────
const $sp = (id) => document.getElementById(id);
const spToggleBtn = $sp("sp-toggle");
const spStatusEl = $sp("sp-status");

if (spToggleBtn && window.bindKaraokeControls) {
  window.bindKaraokeControls({
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
    aiOptions: $sp("sp-ai-options"),
    aiModelSelect: $sp("sp-ai-model"),
    modelHint: $sp("sp-model-hint"),
    aiStatusEl: $sp("sp-ai-status"),
    aiStatusText: $sp("sp-ai-status").querySelector(".ai-status-text"),
    settingsToggle: $sp("sp-settings-toggle"),
    settingsPanel: $sp("sp-settings-panel"),
    serverUrlInput: $sp("sp-server-url"),
    apiKeyInput: $sp("sp-api-key"),
    countdownOverlay: $sp("sp-countdown-overlay"),
    countdownNumber: $sp("sp-countdown-number"),
    countdownCancelBtn: $sp("sp-countdown-cancel"),
  });
}

// --- Init ---
bindToActiveTab();

// Temporary debug heartbeat — prints state every 2s into the side panel's console
// so we can diagnose why the highlight isn't appearing.
setInterval(() => {
  console.log("[KFL-DEBUG]", JSON.stringify({
    domLines: document.querySelectorAll(".line").length,
    activeLines: document.querySelectorAll(".line.active").length,
    parsedLines: parsedLines.length,
    plainLyrics: !!plainLyrics,
    lastPlaybackTime: lastPlaybackTime,
    lastRenderedCount,
    lastRenderedMode,
    activeTabId,
    hasMedia,
    currentLineIndex,
    firstLineTime: parsedLines[0]?.time,
    lastLineTime: parsedLines[parsedLines.length - 1]?.time,
  }));
}, 2000);
