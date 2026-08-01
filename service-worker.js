// Shared song-matching core (title cleaning, candidate scoring, LRCLib request
// building). importScripts runs synchronously and populates self.KarafiltSongMatch.
importScripts("shared/song-match.js");
// deriveVideoKey (globalThis.deriveVideoKey) — same per-song key the side panel
// uses, so usage rows and rating rows agree on what a "song" is.
importScripts("shared/video-key.js");
const SM = self.KarafiltSongMatch;
const { normalizeForMatch, levenshtein, fuzzyTrackMatch } = SM;

// Set to true for verbose console logging during development.
const KF_DEBUG = false;
const dbg = (...args) => { if (KF_DEBUG) console.log(...args); };

// Dev hosts the party host-page detection accepts alongside karafilt.com.
// scripts/package.sh empties this list for production builds (its safety grep
// forbids any dev-host literal in shipped files).
const PARTY_DEV_HOSTS = ["localhost", "127.0.0.1"];

let offscreenReady = false;
let currentMode = "stft";
let currentMix = 1; // 0..1 fraction, mirrored to the offscreen worklet via SET_MIX
let capturedTabId = null;
let capturedTabUrl = null;

// Single point of truth for "which tab is being filtered", mirrored to
// storage.session. The in-memory vars die with every MV3 SW eviction while the
// offscreen document keeps filtering audibly — without the mirror, a restarted
// SW answers PARTY_GET_STATUS with "filter off" mid-party even though the
// filter is clearly running. recoverCaptureState() restores the mirror on boot.
function setCapturedTab(tabId, url) {
  capturedTabId = tabId;
  capturedTabUrl = url;
  if (tabId === null) {
    chrome.storage.session.remove("capturedTab", () => void chrome.runtime.lastError);
  } else {
    chrome.storage.session.set({ capturedTab: { id: tabId, url: url || null } });
  }
}

// Mode/mix survive SW eviction the same way, so a restarted SW reports the
// filter's real settings instead of the "stft"/100% defaults.
function persistFilterPrefs() {
  chrome.storage.session.set({ filterPrefs: { mode: currentMode, mix: currentMix } });
}

async function recoverCaptureState() {
  try {
    const { capturedTab, filterPrefs } = await chrome.storage.session.get({
      capturedTab: null,
      filterPrefs: null,
    });
    if (filterPrefs) {
      if (typeof filterPrefs.mode === "string") currentMode = filterPrefs.mode;
      if (typeof filterPrefs.mix === "number") currentMix = filterPrefs.mix;
    }
    if (!capturedTab || capturedTabId !== null) return;
    // Only trust the mirror while the offscreen document (the actual filter)
    // is still alive; otherwise the capture truly ended with the old SW.
    let offscreenAlive = true;
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      });
      offscreenAlive = !!(contexts && contexts.length > 0);
    }
    if (capturedTabId !== null) return; // a capture started while we awaited
    if (offscreenAlive) {
      capturedTabId = capturedTab.id;
      capturedTabUrl = capturedTab.url;
    } else {
      chrome.storage.session.remove("capturedTab", () => void chrome.runtime.lastError);
    }
  } catch (e) {
    console.warn("[SW] recoverCaptureState failed:", e);
  }
}
// Party handlers await this before answering: a status request is often the
// very event that woke an evicted SW, and answering from the not-yet-recovered
// in-memory state reports "filter off" mid-party (the page trusts real replies).
const captureStateReady = recoverCaptureState();

// ── Filter usage tracking ───────────────────────────────────────────────────
// A "listen segment" = one contiguous stretch with the filter active on a single
// song in a single mode. The SW owns the timing because capture keeps running
// when the side panel is closed; the panel feeds song titles/artists via
// SET_CURRENT_SONG. Each segment is posted to the website (record_filter_usage)
// when it ends — on stop, navigate-away, tab close, song change, or mode change.
// currentUsage is mirrored to chrome.storage.local (`pendingUsage`) so an
// evicted/crashed SW can still flush the segment on its next start; a 60s alarm
// heartbeat caps how much of an abrupt end we can lose to ~1 minute.
const USAGE_MIN_SECONDS = 3; // ignore accidental blips
const USAGE_HEARTBEAT_ALARM = "kf-usage-heartbeat";
let currentUsage = null; // open segment, or null when not filtering
let lastKnownSong = null; // last song the panel reported (seeds segment metadata)

function persistUsage() {
  if (currentUsage) chrome.storage.local.set({ pendingUsage: currentUsage });
  else chrome.storage.local.remove("pendingUsage");
}

// Begin a segment for the current tab/mode, seeding song metadata from the last
// panel report when it matches the same video key (so even the first segment has
// a title; panel-closed sessions get video_key only).
function openUsage(url, mode, meta) {
  // Never overwrite an open segment without recording it first.
  if (currentUsage) flushUsage(Date.now());
  const key = deriveVideoKey(url || capturedTabUrl);
  if (!meta && lastKnownSong && lastKnownSong.videoKey === key) meta = lastKnownSong;
  const t = Date.now();
  currentUsage = {
    videoKey: key,
    videoUrl: url || capturedTabUrl || null,
    songTitle: (meta && meta.songTitle) || null,
    trackName: (meta && meta.trackName) || null,
    artistName: (meta && meta.artistName) || null,
    mode: mode || currentMode || null,
    startedAtMs: t,
    lastBeatMs: t,
  };
  persistUsage();
  chrome.alarms.create(USAGE_HEARTBEAT_ALARM, { periodInMinutes: 1 });
}

// End the open segment (if any) and post it. Idempotent: safe to call from every
// stop path even when nothing is open.
function flushUsage(endMs) {
  const seg = currentUsage;
  currentUsage = null;
  persistUsage();
  chrome.alarms.clear(USAGE_HEARTBEAT_ALARM);
  if (!seg || !seg.videoKey) return;
  const end = endMs || seg.lastBeatMs || Date.now();
  const seconds = Math.round((end - seg.startedAtMs) / 1000);
  if (seconds < USAGE_MIN_SECONDS) return;
  sendFilterUsage({
    videoKey: seg.videoKey,
    videoUrl: seg.videoUrl,
    songTitle: seg.songTitle,
    trackName: seg.trackName,
    artistName: seg.artistName,
    filterMode: seg.mode,
    seconds,
    startedAt: seg.startedAtMs,
    endedAt: end,
    extensionVersion: chrome.runtime.getManifest().version,
  });
}

// Cookie-carrying POST to the website — same auth path as SUBMIT_FILTER_RATING.
async function sendFilterUsage(payload) {
  const { websiteUrl } = await chrome.storage.local.get({
    websiteUrl: "https://karafilt.com",
  });
  const base = (websiteUrl || "").trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    await fetchWithTimeout(
      `${base}/api/filter-usage`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      },
      8000,
    );
  } catch {
    // Best-effort telemetry — a dropped segment isn't worth retrying.
  }
}

// On SW startup, flush any segment a previous (evicted) worker left open. Capture
// state doesn't survive a SW restart, so the segment ended around its last
// heartbeat.
async function recoverPendingUsage() {
  const { pendingUsage } = await chrome.storage.local.get({ pendingUsage: null });
  if (!pendingUsage || !pendingUsage.videoKey) return;
  await chrome.storage.local.remove("pendingUsage");
  const end = pendingUsage.lastBeatMs || pendingUsage.startedAtMs;
  const seconds = Math.round((end - pendingUsage.startedAtMs) / 1000);
  if (seconds < USAGE_MIN_SECONDS) return;
  sendFilterUsage({
    videoKey: pendingUsage.videoKey,
    videoUrl: pendingUsage.videoUrl,
    songTitle: pendingUsage.songTitle,
    trackName: pendingUsage.trackName,
    artistName: pendingUsage.artistName,
    filterMode: pendingUsage.mode,
    seconds,
    startedAt: pendingUsage.startedAtMs,
    endedAt: end,
    extensionVersion: chrome.runtime.getManifest().version,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== USAGE_HEARTBEAT_ALARM) return;
  if (!currentUsage) {
    chrome.alarms.clear(USAGE_HEARTBEAT_ALARM);
    return;
  }
  // If capture is no longer active, close the segment at the last good beat.
  if (capturedTabId === null) {
    flushUsage(currentUsage.lastBeatMs);
    return;
  }
  currentUsage.lastBeatMs = Date.now();
  persistUsage();
});

recoverPendingUsage();

// The side panel is PINNED to one tab at a time: disabled by default
// everywhere, enabled only for the tab the user invoked Karafilt on (icon
// click, Ctrl+Shift+K, or the context menu). Chrome then shows the panel only
// on that tab — switching away hides it, switching back restores it. Both
// calls run on every SW start so the defaults survive restarts (and clear the
// openPanelOnActionClick behaviour persisted by older versions).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {});
chrome.sidePanel
  .setOptions({ enabled: false })
  .catch((err) => console.error("[SW] sidePanel default-disable failed:", err));

// Pin the panel to a tab. Fire-and-forget: callers run inside a user gesture
// and must not await before their own gesture-bound calls (sidePanel.open,
// tabCapture.getMediaStreamId). Disables the previously bound tab so exactly
// one tab owns the panel; boundTabId is kept in storage.session so the panel
// page and SW restarts can recover it.
function bindPanelToTab(tabId) {
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel/sidepanel.html", enabled: true })
    .catch((err) => console.error("[SW] sidePanel enable failed:", err));
  chrome.storage.session.get({ boundTabId: null }, ({ boundTabId }) => {
    if (boundTabId != null && boundTabId !== tabId) {
      chrome.sidePanel
        .setOptions({ tabId: boundTabId, enabled: false })
        .catch(() => {});
    }
    chrome.storage.session.set({ boundTabId: tabId });
  });
}

// Transient "can't filter here" feedback for ineligible tabs (chrome://, the
// Web Store…) where no panel can open.
function flashIneligibleBadge(tabId) {
  chrome.action.setBadgeText({ text: "✕", tabId }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
  }, 2000);
}

// Icon click — open the side panel pinned to this tab. Filtering does NOT
// start automatically: the user presses Start in the panel (the click's
// activeTab grant lets the SW capture this tab picker-free when they do).
// Ctrl+Shift+K and the context menu remain explicit filter toggles. If
// filtering is still running on a previously pinned tab, stop it so the
// moved panel's Start/Stop state matches its new tab.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id || !tab.url || !/^https?:/.test(tab.url)) {
    if (tab && tab.id) flashIneligibleBadge(tab.id);
    return;
  }
  bindPanelToTab(tab.id);
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  if (capturedTabId !== null && capturedTabId !== tab.id) {
    flushUsage(Date.now());
    setCapturedTab(null, null);
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
    chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
  }
});

// Toggle capture for a tab: stop if it's the currently-captured tab,
// otherwise start a fresh capture. Called from chrome.commands.onCommand
// (keyboard shortcut). Must be invoked synchronously inside an invocation
// event handler — the chrome.tabCapture.getMediaStreamId call below relies
// on the user gesture being fresh, so no awaits before that line.
function toggleCaptureForTab(tab) {
  if (!tab || !tab.id || !tab.url || !/^https?:/.test(tab.url)) {
    console.warn("[SW] toggleCaptureForTab: no eligible tab");
    return;
  }
  if (capturedTabId === tab.id) {
    flushUsage(Date.now());
    setCapturedTab(null, null);
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
    chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
    return;
  }
  chrome.tabCapture
    .getMediaStreamId({ targetTabId: tab.id })
    .then(async (streamId) => {
      const result = await handleStartCapture(tab.id, streamId);
      if (result && result.success) {
        chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: true }).catch(() => {});
      }
    })
    .catch((err) => {
      console.error("[SW] toggleCaptureForTab: tabCapture failed:", err && err.message);
    });
}

// True for the website party host page (mirrors the party-bridge.js
// content_scripts matches in manifest.json, including the local dev site).
// There the page has its own UI (lyrics, queue, filter controls), so the
// filter triggers skip opening the space-consuming side panel and just toggle
// capture.
function isPartyHostPage(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return (
      (host === "karafilt.com" || PARTY_DEV_HOSTS.includes(host)) &&
      u.pathname.startsWith("/party/")
    );
  } catch {
    return false;
  }
}

// Auto-inject the content script into every open http(s) tab on extension
// load. Manifest V3 content_scripts only run on pages loaded AFTER the
// extension is enabled — without this, every chrome://extensions reload
// orphans existing tabs and the user has to refresh them manually before
// the side panel can find the song. The content script's
// __karaokeFilterLyricsLoaded guard makes double-injection a no-op.
async function injectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["shared/song-match.js", "content/lyrics-overlay.js"],
        });
        // Party pages also need the postMessage bridge — without this, a host
        // page left open across an extension reload loses its filter panel
        // (the old bridge's runtime binding is dead) until a manual refresh.
        if (isPartyHostPage(tab.url)) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content/party-bridge.js"],
          });
        }
      } catch {
        // Some URLs reject programmatic injection (e.g. chrome web store).
        // Silently skip — nothing we can do for those.
      }
    }
  } catch (e) {
    console.warn("[SW] injectIntoOpenTabs failed:", e);
  }
}

chrome.runtime.onInstalled.addListener(injectIntoOpenTabs);
chrome.runtime.onStartup.addListener(injectIntoOpenTabs);

// Keyboard-shortcut path for Start/Stop Filtering. The chrome.commands API
// fires onCommand with a fresh, unambiguous "user invocation" context — this
// works reliably across Chrome, Brave, Edge, etc., where the side-panel
// button click sometimes doesn't carry through the activeTab grant that
// chrome.tabCapture.getMediaStreamId requires. We call tabCapture
// synchronously with the tab provided by the event (no await beforehand)
// to keep the user gesture intact.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-filter") return;
  if (tab && tab.id && tab.url && /^https?:/.test(tab.url)) {
    bindPanelToTab(tab.id);
    // On the party host page, don't steal space with the side panel — the page
    // has its own UI. Elsewhere the panel is the only surface, so open it.
    if (!isPartyHostPage(tab.url)) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
  toggleCaptureForTab(tab);
});

// Right-click → "Filter this tab" context menu. A context-menu click grants the
// activeTab permission that chrome.tabCapture needs, so it captures the current
// tab directly with NO screen-share picker (unlike a side-panel button click).
// Mirrors the keyboard-command path: open the side panel, then toggle capture
// synchronously to keep the user gesture intact for getMediaStreamId.
const FILTER_TAB_MENU_ID = "karafilt-filter-this-tab";

function setupContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError; // ignore "no menus" on first run
      chrome.contextMenus.create({
        id: FILTER_TAB_MENU_ID,
        title: "Filter this tab with Karafilt",
        contexts: ["page"],
        documentUrlPatterns: ["http://*/*", "https://*/*"],
      }, () => void chrome.runtime.lastError);
    });
  } catch (e) {
    console.warn("[SW] context menu setup failed:", e);
  }
}

chrome.runtime.onInstalled.addListener(setupContextMenu);
chrome.runtime.onStartup.addListener(setupContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== FILTER_TAB_MENU_ID || !tab || !tab.id) return;
  bindPanelToTab(tab.id);
  // Party host page provides its own UI — toggle the filter without the panel.
  if (!isPartyHostPage(tab.url)) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  toggleCaptureForTab(tab);
});

// In-memory cache for LRCLib lookups — keeps us from hammering the API
// on title-watchers that fire multiple times per page.
const lyricsCache = new Map();
const LYRICS_CACHE_MAX = 50;

// fetch() with a hard deadline. Without this, a slow/hung upstream blocks
// until the browser's default socket timeout (~30-120s). An aborted fetch
// throws — every call site handles that as a clean miss.
async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(opts || {}), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── lrclib request throttle ─────────────────────────────────────────────────
// A song lookup can fan out ~15 lrclib requests (up to 5 candidates × 3 URLs).
// The browser caps ~6 connections per host, so the overflow is QUEUED by the
// browser — but each request's abort timer is already running while it waits, so
// the queued ones time out before they're even sent (observed: repeated
// "lyrics: miss in 5000ms"). Two fixes:
//   1. Cap our own concurrency so the abort timer only starts once a slot is
//      free — every request then gets its full timeout window.
//   2. Dedupe identical in-flight URLs so overlapping candidate queries share a
//      single network call.
const LRCLIB_MAX_CONCURRENT = 5;            // stay under the browser's ~6/host
const LRCLIB_MAX_QUEUE = 16;                // bound the backlog (drop the stalest)
let lrclibActive = 0;
const lrclibWaiters = [];
const lrclibInflight = new Map();           // url -> Promise<json|null>

// Resolves true once a slot is free, or false if the request was evicted because
// the queue overflowed (a backlog of stale/superseded lookups). The timeout only
// starts after this resolves true, so queued requests get their full window.
function lrclibAcquire() {
  if (lrclibActive < LRCLIB_MAX_CONCURRENT) {
    lrclibActive++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    lrclibWaiters.push(resolve);
    // Evict the OLDEST waiter (stalest — usually a song the user already skipped
    // past) so the queue can't grow unbounded and starve the current request.
    while (lrclibWaiters.length > LRCLIB_MAX_QUEUE) {
      lrclibWaiters.shift()(false);
    }
  });
}

function lrclibRelease() {
  const next = lrclibWaiters.shift();
  if (next) next(true);      // transfer the slot straight to the next waiter
  else lrclibActive--;       // otherwise free it
}

// Throttled + deduped GET → parsed JSON (or null).
function lrclibFetchJson(url, timeoutMs) {
  const existing = lrclibInflight.get(url);
  if (existing) return existing;
  const p = (async () => {
    const proceed = await lrclibAcquire();
    if (!proceed) return null;          // evicted from the queue (stale) — skip
    try {
      const r = await fetchWithTimeout(url, null, timeoutMs);
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    } finally {
      lrclibRelease();
    }
  })();
  lrclibInflight.set(url, p);
  p.finally(() => lrclibInflight.delete(url));
  return p;
}

// Lyrics are a pure third-party database lookup (LRCLib synced/plain, with
// Lyrics.ovh + Genius plain fallbacks). No backend transcription or forced
// alignment — whatever the database returns is shown as-is.
//
// opts.lrclibOnly: skip Lyrics.ovh + Genius fallbacks (used during phase 1
//   of the content-script's two-phase loop, so we only pay for fast LRCLib
//   API calls across all candidates).
// opts.forceRefresh: bypass the in-memory lyricsCache (used by the manual
//   Refresh button).
async function handleFetchLyrics(artist, track, tabId, opts) {
  const lrclibOnly = !!(opts && opts.lrclibOnly);
  const forceRefresh = !!(opts && opts.forceRefresh);
  const skipLrclib = !!(opts && opts.skipLrclib);
  const durationSec = (opts && opts.durationSec) || 0;
  const album = (opts && opts.album) || "";
  const videoKey = (opts && opts.videoKey) || null;

  return fetchFromLRCLib(artist, track, { lrclibOnly, forceRefresh, skipLrclib, durationSec, album, videoKey });
}

// Keyed by video identity AS WELL as the parsed name: Karalyr resolves lyrics
// by video id, so the same {artist, track} candidate can legitimately map to
// different lyrics on different videos (same-titled songs, covers, sped-up
// re-uploads). A name-only key served video A's lyrics to video B.
function cacheKey(artist, track, videoKey) {
  return `${videoKey || ""}|${(artist || "").toLowerCase()}|${(track || "").toLowerCase()}`;
}

// normalizeForMatch / levenshtein / fuzzyTrackMatch now live in
// shared/song-match.js (aliased at the top of this file) so the request side
// and the match side can never drift apart. They're still used below by the
// Genius scraper to verify a scraped hit actually matches what we asked for.

// Genius.com — public web search + HTML scrape. Plain text only (no timestamps).
// Has the widest coverage of the free sources, including lots of indie/regional
// tracks LRCLib and lyrics.ovh miss. We use the same internal search endpoint the
// website itself uses, then fetch the song page and extract the lyrics container
// div contents.
function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; }
    });
}

function htmlFragmentToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

// Walk the page HTML and extract the inner content of every
// <div data-lyrics-container="true">…</div>, handling nested <div> tags
// correctly (annotations sometimes nest divs).
function extractGeniusLyricsFromHtml(html) {
  const blocks = [];
  let pos = 0;
  while (pos < html.length) {
    const markerIdx = html.indexOf('data-lyrics-container="true"', pos);
    if (markerIdx === -1) break;
    // Find the end of the opening tag we're inside
    const tagEnd = html.indexOf(">", markerIdx);
    if (tagEnd === -1) break;
    // Walk forward counting <div ... > opens and </div> closes
    let depth = 1;
    let cursor = tagEnd + 1;
    const contentStart = cursor;
    let blockEnd = -1;
    while (cursor < html.length && depth > 0) {
      const nextOpen = html.indexOf("<div", cursor);
      const nextClose = html.indexOf("</div", cursor);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        const after = html.indexOf(">", nextOpen);
        cursor = after === -1 ? html.length : after + 1;
      } else {
        depth--;
        if (depth === 0) {
          blockEnd = nextClose;
          const after = html.indexOf(">", nextClose);
          cursor = after === -1 ? html.length : after + 1;
          break;
        }
        const after = html.indexOf(">", nextClose);
        cursor = after === -1 ? html.length : after + 1;
      }
    }
    if (blockEnd !== -1) {
      blocks.push(html.slice(contentStart, blockEnd));
    }
    pos = cursor;
  }
  if (blocks.length === 0) return null;
  const text = blocks.map(htmlFragmentToText).join("\n").trim();
  return text || null;
}

// Strip the "N Contributors<TrackName> Lyrics" preamble Genius prepends to its
// lyrics container, plus the "EmbedShare" / "X Embed" footer some pages append.
function cleanGeniusLyrics(text) {
  return text
    .replace(/^\s*(?:read more\s*)?\d+\s*contributors?[\s\S]*?lyrics\s*\n+/i, "")
    .replace(/\d*\s*Embed\s*$/i, "")
    .trim();
}

async function fetchGeniusPageLyrics(url) {
  try {
    const res = await fetchWithTimeout(url, null, 6000);
    if (!res.ok) return null;
    const html = await res.text();
    const raw = extractGeniusLyricsFromHtml(html);
    if (!raw) return null;
    const cleaned = cleanGeniusLyrics(raw);
    return cleaned && cleaned.length >= 30 ? cleaned : null;
  } catch {
    return null;
  }
}

async function fetchFromGenius(artist, track) {
  if (!track) return { found: false };
  const query = (artist ? `${artist} ${track}` : track).trim();
  try {
    const searchUrl = `https://genius.com/api/search/multi?per_page=10&q=${encodeURIComponent(query)}`;
    const sres = await fetchWithTimeout(searchUrl, { headers: { "Accept": "application/json" } }, 5000);
    if (!sres.ok) return { found: false };
    const sdata = await sres.json();

    // Collect ALL unique song hits across sections, then filter to ones that
    // actually fuzzy-match the requested track. Without this the previous
    // implementation accepted whatever Genius ranked first — which is often
    // a wholly different song when the search query is a noisy YouTube title.
    const sections = (sdata && sdata.response && sdata.response.sections) || [];
    const songHits = [];
    const seenUrls = new Set();
    for (const section of sections) {
      if (!section) continue;
      for (const hit of (section.hits || [])) {
        if (!hit || !hit.result || !hit.result.url || !hit.result.title) continue;
        if (seenUrls.has(hit.result.url)) continue;
        seenUrls.add(hit.result.url);
        songHits.push({
          url: hit.result.url,
          title: hit.result.title,
          artist: (hit.result.primary_artist && hit.result.primary_artist.name) || "",
        });
      }
    }

    const wanted = normalizeForMatch(track);
    const titleMatches = songHits
      .filter((h) => fuzzyTrackMatch(h.title, track))
      .map((h) => ({ ...h, dist: levenshtein(normalizeForMatch(h.title), wanted) }))
      .sort((a, b) => a.dist - b.dist);
    // With a known artist, only accept hits whose primary artist matches it —
    // Genius search happily returns a same-titled song by someone else, and as
    // the last-resort source nothing downstream would catch that. Showing no
    // lyrics beats showing another artist's.
    const matching = artist
      ? titleMatches.filter((h) => SM.artistMatchStrong(h.artist, artist))
      : titleMatches;

    if (matching.length === 0) return { found: false };

    // Fetch only the single best-match page. Scraping the alternative pages
    // too (for the "wrong song?" picker) tripled-to-quadrupled tail latency
    // for a feature the user rarely opens.
    const primaryLyrics = await fetchGeniusPageLyrics(matching[0].url);
    if (!primaryLyrics) return { found: false };

    return {
      found: true,
      syncedLyrics: null,
      plainLyrics: primaryLyrics,
      trackName: matching[0].title,
      artistName: matching[0].artist,
      source: "genius",
      alternatives: [],
    };
  } catch (err) {
    console.error("[SW] Genius fetch failed:", err);
    return { found: false };
  }
}

// Lyrics.ovh — free, no-auth API. Plain text lyrics only (no timestamps).
// Different coverage than LRCLib — sometimes has songs LRCLib misses.
async function fetchFromLyricsOvh(artist, track) {
  if (!artist || !track) return { found: false };
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`;
  try {
    const res = await fetchWithTimeout(url, null, 5000);
    if (!res.ok) return { found: false };
    const data = await res.json();
    if (data && typeof data.lyrics === "string" && data.lyrics.trim().length > 30) {
      return {
        found: true,
        syncedLyrics: null,
        plainLyrics: data.lyrics.trim(),
        // Echo the queried identity — downstream consumers (word-sync queue
        // submissions) need a track identity on every match.
        trackName: track,
        artistName: artist,
        source: "lyrics.ovh",
      };
    }
  } catch (err) {
    console.error("[SW] Lyrics.ovh fetch failed:", err);
  }
  return { found: false };
}

// --- Karalyr (community karaoke DB, LRCLIB-compatible + word timing) ---
// Tried BEFORE lrclib.net: Karalyr serves only word-synced karaoke lyrics —
// exactly what LRCLib doesn't have. A miss is a plain 404 and the chain
// falls through to LRCLib and the other sources. Base URL is configurable
// via chrome.storage.local karalyrBase; a dead server fails fast.
let karalyrBase = "https://www.karalyr.com";
try {
  chrome.storage.local.get("karalyrBase").then((v) => {
    if (v && typeof v.karalyrBase === "string" && v.karalyrBase) karalyrBase = v.karalyrBase;
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.karalyrBase) {
      karalyrBase = changes.karalyrBase.newValue || "https://www.karalyr.com";
    }
  });
} catch (e) { /* keep default */ }

async function fetchFromKaralyr(artist, track, album, durationSec, videoKey) {
  // The by-video-id lookup needs no parsed name at all — only skip entirely
  // when there's neither a video key nor a usable {artist, track} pair.
  if (!karalyrBase || (!videoKey && (!artist || !track))) return { found: false };

  const fetchJson = async (path, params) => {
    const u = new URL(path, karalyrBase);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(u.toString(), { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const tryGet = (a, t, alb, dur) => {
    const params = { artist_name: a, track_name: t };
    if (alb) params.album_name = alb;
    if (dur > 0) params.duration = String(Math.round(dur));
    return fetchJson("/api/get", params);
  };

  // Exact /api/get missed for every spelling of this candidate. Karalyr's FTS
  // search still finds rows whose STORED identity differs from the parsed one
  // (e.g. an offline-aligned import saved under channel + raw video title).
  // FTS only returns rows containing every query term, so acceptance is the
  // usual fuzzy accept OR full token coverage (identityCovers); search rows
  // carry no lyrics, so the winner is re-fetched by its exact stored identity.
  const trySearch = async () => {
    const rows = await fetchJson("/api/search", { q: `${track} ${artist}` });
    if (!Array.isArray(rows) || !rows.length) return null;
    const want = { track, artist, durationSec };
    const usable = rows.filter(
      (r) =>
        r && r.karalyr && r.karalyr.has_lyrics &&
        (SM.accept(r, want) || SM.identityCovers(r.artistName, r.trackName, want))
    );
    if (!usable.length) return null;
    usable.sort((a, b) => SM.scoreRow(a, want) - SM.scoreRow(b, want));
    const hit = usable[0];
    return tryGet(hit.artistName, hit.trackName, hit.albumName || "", hit.duration || 0);
  };

  try {
    // Exact by-video lookup first: Karalyr stores video→track links for
    // contributions synced against a specific video (track_videos), so this
    // hits regardless of how the track's name is stored or parsed. yt: keys
    // go as youtube_id (understood by older Karalyr servers); sp: keys use
    // the newer video_key param — an older server just 404s and the chain
    // falls through to name matching.
    let row = null;
    let matchedBy = "name";
    if (videoKey && videoKey.startsWith("yt:")) {
      row = await fetchJson("/api/get", { youtube_id: videoKey.slice(3) });
      if (row) matchedBy = "video-id";
    } else if (videoKey && videoKey.startsWith("sp:")) {
      row = await fetchJson("/api/get", { video_key: videoKey });
      if (row) matchedBy = "video-id";
    }
    if (!row && artist && track) {
      row = await tryGet(artist, track, album, durationSec > 0 ? durationSec : 0);
      if (!row && durationSec > 0) row = await tryGet(artist, track, album, 0);
      if (!row) row = await trySearch();
    }
    if (!row || (!row.syncedLyrics && !row.plainLyrics)) return { found: false };
    dbg(`[SW] Karalyr hit (${matchedBy}): ${row.artistName} — ${row.trackName} (tier ${row.karalyr && row.karalyr.tier})`);
    return {
      found: true,
      syncedLyrics: row.syncedLyrics || null,
      plainLyrics: row.plainLyrics || null,
      trackName: row.trackName,
      artistName: row.artistName,
      source: "karalyr",
      // "video-id" = resolved from the video's own identity (ground truth for
      // this exact video); "name" = resolved by parsed-name matching, no more
      // trustworthy than any other name match. The content script fast-tracks
      // only the former.
      matchedBy,
      // Word-level timing already exists server-side — the side panel skips
      // auto word-sync requests for these.
      wordTimed: !!(row.karalyr && row.karalyr.has_word_timing),
      // Lets the side panel rate these lyrics (POST /api/signal needs the
      // active revision, not the track).
      karalyrRevisionId: (row.karalyr && row.karalyr.revision_id) || null,
      // effScore convention elsewhere: lower is better. A by-id hit is
      // identity-certain; a name-based hit gets an honest composite score so
      // it competes fairly with LRCLib picks instead of always winning.
      matchScore: matchedBy === "video-id"
        ? (row.syncedLyrics ? -10 : 40)
        : SM.scoreRow(row, { track, artist, durationSec }),
      matchSynced: !!row.syncedLyrics,
      alternatives: [],
    };
  } catch (err) {
    return { found: false };
  }
}

async function fetchFromLRCLib(artist, track, opts) {
  const lrclibOnly = !!(opts && opts.lrclibOnly);
  const forceRefresh = !!(opts && opts.forceRefresh);
  // skipLrclib: phase 2 of the content-script loop has already tried LRCLib
  // for every candidate, so re-running /api/get + /api/search here is wasted
  // network time — jump straight to the Lyrics.ovh + Genius fallbacks.
  const skipLrclib = !!(opts && opts.skipLrclib);
  const album = (opts && opts.album) || "";
  const durationSec = (opts && opts.durationSec) || 0;
  const videoKey = (opts && opts.videoKey) || null;
  const key = cacheKey(artist, track, videoKey);
  if (!forceRefresh && lyricsCache.has(key)) return lyricsCache.get(key);

  let result = { found: false };
  // lrclibOnly + skipLrclib leaves nothing to do — a clean miss.
  if (lrclibOnly && skipLrclib) return result;

  const t0 = performance.now();
  // Karalyr first (community + word-timed lyrics). skipLrclib means phase 2
  // of the content-script loop — Karalyr was already tried in phase 1.
  if (!skipLrclib) {
    result = await fetchFromKaralyr(artist, track, album, durationSec, videoKey);
  }

  let lrclibMs = 0;
  if (!skipLrclib && !result.found) {
   try {
    // Build the full request set for this candidate: /api/get (with + without
    // duration), structured /api/search?track_name&artist_name, free-text
    // /api/search?q, and diacritic-folded variants — all in parallel (~400ms
    // wall-clock). Each fetch catches its own error so one timeout doesn't
    // discard the others. See shared/song-match.js buildLrclibRequests.
    const reqs = SM.buildLrclibRequests({ artist, track, album, durationSec });
    // Throttled + deduped so the ~15-request burst doesn't exceed the browser's
    // per-host connection cap and time out (see lrclibFetchJson above).
    const responses = await Promise.all(
      reqs.map((req) => lrclibFetchJson(req.url, req.timeout || 5000))
    );
    // /api/get returns one object; /api/search returns an array. Flatten.
    const rows = [];
    for (const resp of responses) {
      if (!resp) continue;
      if (Array.isArray(resp)) rows.push(...resp);
      else rows.push(resp);
    }

    // Composite scoring: artist-aware gate, then synced-first then
    // (trackDist + artistDist + durationPenalty). Picks the right artist's row
    // even among many same-titled matches, and the right recording by duration.
    const picked = SM.pickBest(rows, { track, artist, durationSec });
    if (picked) {
      result = {
        found: true,
        syncedLyrics: picked.best.syncedLyrics || null,
        plainLyrics: picked.best.plainLyrics || null,
        trackName: picked.best.trackName,
        artistName: picked.best.artistName,
        source: "lrclib",
        matchScore: picked.score,
        matchSynced: picked.synced,
        alternatives: picked.alternatives.map((r) => ({
          trackName: r.trackName,
          artistName: r.artistName,
          syncedLyrics: r.syncedLyrics || null,
          plainLyrics: r.plainLyrics || null,
          source: "lrclib",
        })),
      };
    }
   } catch (err) {
    console.error("[SW] LRCLib fetch failed:", err);
   }
   lrclibMs = performance.now() - t0;
  }

  // Skip the heavyweight fallbacks during phase 1 of the content-script's
  // two-phase loop — Genius alone takes ~3-5s per candidate, which adds up
  // to ~30s when LRCLib misses on every candidate.
  let ovhMs = 0;
  let geniusMs = 0;
  if (!lrclibOnly) {
    // If LRCLib found nothing, try Lyrics.ovh as a secondary source.
    // Lyrics.ovh requires both artist and track in the URL path — skip it for
    // track-only candidates.
    if (!result.found && artist) {
      const ovhStart = performance.now();
      const ovh = await fetchFromLyricsOvh(artist, track);
      ovhMs = performance.now() - ovhStart;
      if (ovh.found) result = ovh;
    }

    // Final fallback: Genius (web scrape). Wider coverage than the JSON APIs.
    if (!result.found) {
      const geniusStart = performance.now();
      const gen = await fetchFromGenius(artist, track);
      geniusMs = performance.now() - geniusStart;
      if (gen.found) result = gen;
    }
  }

  // One-line latency summary so "why so long" is answerable from the console.
  const totalMs = Math.round(performance.now() - t0);
  const parts = [];
  if (!skipLrclib) parts.push(`lrclib ${Math.round(lrclibMs)}ms`);
  if (ovhMs) parts.push(`ovh ${Math.round(ovhMs)}ms`);
  if (geniusMs) parts.push(`genius ${Math.round(geniusMs)}ms`);
  dbg(
    `[SW] lyrics: ${result.found ? `${result.source} hit` : "miss"} in ${totalMs}ms` +
      (parts.length ? ` (${parts.join(", ")})` : "")
  );

  // Don't cache LRCLib-only misses — phase 2 of the content-script loop will
  // re-call us with the full chain enabled, and a cached `{found: false}` from
  // phase 1 would short-circuit that. Hits and full-chain misses are both fine
  // to cache.
  const isLrclibOnlyMiss = lrclibOnly && !result.found;
  if (!isLrclibOnlyMiss) {
    if (lyricsCache.size >= LYRICS_CACHE_MAX) {
      const firstKey = lyricsCache.keys().next().value;
      lyricsCache.delete(firstKey);
    }
    lyricsCache.set(key, result);
  }
  return result;
}

// Filter controls shared by the internal side-panel messages and the external
// Party Mode page bridge (onMessageExternal below). setFilterMode re-segments
// usage so time is attributed per mode; setFilterMix mirrors the 0..1 value to
// the offscreen worklet.
function setFilterMix(value) {
  currentMix = value;
  persistFilterPrefs();
  chrome.runtime.sendMessage({ type: "SET_MIX", value });
}
function setFilterMode(value) {
  currentMode = value;
  persistFilterPrefs();
  if (currentUsage) {
    const meta = {
      videoKey: currentUsage.videoKey,
      songTitle: currentUsage.songTitle,
      trackName: currentUsage.trackName,
      artistName: currentUsage.artistName,
    };
    flushUsage(Date.now());
    openUsage(capturedTabUrl, currentMode, meta);
  }
  chrome.runtime.sendMessage({ type: "SET_MODE", value });
}

// videoKeys with a QUEUE_WORD_SYNC submission currently in flight, so a
// panel that fires twice (e.g. reopened mid-song) can't double-post.
const wordSyncInFlight = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages from the offscreen document. (AI status/lag/seek are gone now that
  // all processing runs in-browser in the worklet.)
  if (sender.url && sender.url.includes("offscreen.html")) {
    return;
  }

  dbg("[SW] received message:", message.type, "from:", sender.url || "unknown");

  switch (message.type) {
    case "START_CAPTURE":
      if (message.mode) { currentMode = message.mode; persistFilterPrefs(); }
      dbg("[SW] START_CAPTURE mode:", currentMode, "tabId:", message.tabId);
      handleStartCapture(message.tabId, message.streamId).then((result) => {
        // Broadcast capture state so all surfaces reflect it.
        if (result && result.success) {
          chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: true }).catch(() => {});
        }
        sendResponse(result);
      });
      return true; // async response

    case "START_CAPTURE_DISPLAY_MEDIA":
      if (message.mode) { currentMode = message.mode; persistFilterPrefs(); }
      dbg("[SW] START_CAPTURE_DISPLAY_MEDIA mode:", currentMode, "tabId:", message.tabId);
      handleStartCaptureViaDisplayMedia(message.tabId).then((result) => {
        if (result && result.success) {
          chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: true }).catch(() => {});
        }
        sendResponse(result);
      });
      return true; // async response

    case "STOP_CAPTURE":
      dbg("[SW] STOP_CAPTURE received, forwarding to offscreen");
      flushUsage(Date.now());
      setCapturedTab(null, null);
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
      break;

    case "SET_MIX":
      setFilterMix(message.value);
      break;

    case "SET_MODE":
      setFilterMode(message.value);
      break;

    case "SET_CURRENT_SONG": {
      // The side panel reports the active song's metadata (it has the title/
      // artist the SW can't see). Cache it to seed future segments, and enrich or
      // re-segment the open one.
      const song = message.song || {};
      if (song.videoKey) lastKnownSong = song;
      if (currentUsage) {
        if (song.videoKey && song.videoKey !== currentUsage.videoKey) {
          flushUsage(Date.now());
          openUsage(song.videoUrl || capturedTabUrl, currentMode, song);
        } else {
          if (song.songTitle) currentUsage.songTitle = song.songTitle;
          if (song.trackName) currentUsage.trackName = song.trackName;
          if (song.artistName) currentUsage.artistName = song.artistName;
          if (song.videoUrl) currentUsage.videoUrl = song.videoUrl;
          persistUsage();
        }
      }
      break;
    }

    case "FETCH_LYRICS": {
      const tabId = sender.tab ? sender.tab.id : null;
      handleFetchLyrics(message.artist, message.track, tabId, {
        lrclibOnly: !!message.lrclibOnly,
        forceRefresh: !!message.forceRefresh,
        skipLrclib: !!message.skipLrclib,
        durationSec: message.durationSec || 0,
        album: message.album || "",
        // The playing song's exact identity: the content script's site
        // adapter supplies it where the tab URL can't (Spotify's URL doesn't
        // change per song); otherwise derive from the sender's tab URL.
        // Karalyr resolves lyrics by this key ahead of any name matching.
        videoKey:
          (typeof message.videoKey === "string" && message.videoKey) ||
          (sender.tab && sender.tab.url ? deriveVideoKey(sender.tab.url) : null),
      }).then(sendResponse);
      return true; // async response
    }

    case "SET_SHOW_LYRICS":
      // Broadcast to all tabs so each content script can show/hide its overlay
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          if (tab.id != null) {
            chrome.tabs.sendMessage(tab.id, {
              type: "SET_SHOW_LYRICS",
              value: message.value,
            }).catch(() => { /* not all tabs have the content script */ });
          }
        }
      });
      break;

    case "GET_STATE":
      sendResponse({ isActive: capturedTabId !== null });
      return false;

    case "OPEN_LOGIN":
      // Open the sign-in page in a floating popup window — reads like a
      // modal auth dialog, and the music tab never loses visibility. The
      // tabs.onUpdated watcher below closes it the moment login lands on
      // /account.
      (async () => {
        const width = 420, height = 640;
        let bounds = { width, height };
        try {
          // Center on the user's current window.
          const cur = await chrome.windows.getLastFocused();
          bounds.left = Math.max(0, Math.round((cur.left ?? 0) + ((cur.width ?? width) - width) / 2));
          bounds.top = Math.max(0, Math.round((cur.top ?? 0) + ((cur.height ?? height) - height) / 2));
        } catch {}
        const win = await chrome.windows.create({
          url: message.loginUrl,
          type: "popup",
          ...bounds,
        });
        const loginTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
        await chrome.storage.session.set({
          loginWatch: {
            loginTabId,
            loginWindowId: win.id,
            returnTabId: message.returnTabId ?? null,
          },
        });
      })();
      break;

    case "GET_ACCOUNT_STATUS":
      // Session probe for the side panel's account chip. Uses the same
      // cookie-carrying fetch against the site session, read-only (/api/me).
      (async () => {
        const { websiteUrl } = await chrome.storage.local.get({
          websiteUrl: "https://karafilt.com",
        });
        const base = (websiteUrl || "").trim().replace(/\/+$/, "");
        if (!base) {
          sendResponse({ disabled: true });
          return;
        }
        try {
          const res = await fetchWithTimeout(
            `${base}/api/me`,
            { credentials: "include", headers: { Accept: "application/json" } },
            8000,
          );
          if (res.ok) {
            const me = await res.json();
            sendResponse({ signedIn: true, ...me, accountUrl: `${base}/account` });
          } else {
            sendResponse({ signedIn: false, status: res.status, loginUrl: `${base}/login` });
          }
        } catch {
          sendResponse({ signedIn: false, error: "network", loginUrl: `${base}/login` });
        }
      })();
      return true; // async response

    case "SUBMIT_FILTER_RATING":
      // Forward a per-song filter rating to the website. Same cookie-carrying
      // fetch as the account probe (the user's site session authenticates it).
      (async () => {
        const { websiteUrl } = await chrome.storage.local.get({
          websiteUrl: "https://karafilt.com",
        });
        const base = (websiteUrl || "").trim().replace(/\/+$/, "");
        if (!base) {
          sendResponse({ ok: false, error: "no_site" });
          return;
        }
        try {
          const res = await fetchWithTimeout(
            `${base}/api/filter-ratings`,
            {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify(message.rating || {}),
            },
            8000,
          );
          sendResponse({ ok: res.ok, status: res.status });
        } catch {
          sendResponse({ ok: false, error: "network" });
        }
      })();
      return true; // async response

    case "QUEUE_WORD_SYNC":
      // Submit {lyrics + video URL + metadata} to the website's alignment
      // queue. Same cookie-carrying fetch as SUBMIT_FILTER_RATING; the site
      // answers 201 {ok:true} when queued, or a reason code otherwise.
      (async () => {
        const req = message.request || {};
        const videoKey = typeof req.videoKey === "string" ? req.videoKey : null;
        if (!videoKey) {
          sendResponse({ ok: false, reason: "upstream" });
          return;
        }
        if (wordSyncInFlight.has(videoKey)) {
          sendResponse({ ok: false, reason: "in_flight" });
          return;
        }
        wordSyncInFlight.add(videoKey);
        try {
          const { websiteUrl } = await chrome.storage.local.get({
            websiteUrl: "https://karafilt.com",
          });
          const base = (websiteUrl || "").trim().replace(/\/+$/, "");
          if (!base) {
            sendResponse({ ok: false, reason: "unavailable" });
            return;
          }
          const res = await fetchWithTimeout(
            `${base}/api/sync-queue`,
            {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({
                ...req,
                extensionVersion: chrome.runtime.getManifest().version,
              }),
            },
            8000,
          );
          if (res.status === 201) {
            sendResponse({ ok: true, status: "queued" });
          } else if (res.status === 401) {
            sendResponse({ ok: false, reason: "unauthenticated" });
          } else {
            let reason = "upstream";
            try {
              const data = await res.json();
              if (data && typeof data.reason === "string" && data.reason) {
                reason = data.reason;
              }
            } catch { /* unparseable body — keep "upstream" */ }
            sendResponse({ ok: false, reason });
          }
        } catch {
          sendResponse({ ok: false, reason: "upstream" });
        } finally {
          wordSyncInFlight.delete(videoKey);
        }
      })();
      return true; // async response

    case "SIGNAL_KARALYR":
      // Thumbs up/down on the Karalyr lyrics revision being played. Karalyr's
      // /api/signal is public (deduped server-side by fingerprint) — no
      // account needed. Routed through the SW so its host permission bypasses
      // CORS. 409 means this browser already rated the revision; the panel
      // treats that as a success and just remembers the vote.
      (async () => {
        const revisionId = message.revisionId;
        const signal = message.signal;
        if (
          !Number.isInteger(revisionId) || revisionId <= 0 ||
          (signal !== "explicit_up" && signal !== "explicit_down")
        ) {
          sendResponse({ ok: false, reason: "bad_request" });
          return;
        }
        try {
          const res = await fetchWithTimeout(
            new URL("/api/signal", karalyrBase).toString(),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ revision_id: revisionId, type: signal }),
            },
            8000,
          );
          if (res.ok) sendResponse({ ok: true });
          else if (res.status === 409) sendResponse({ ok: true, already: true });
          else sendResponse({ ok: false, reason: "upstream" });
        } catch {
          sendResponse({ ok: false, reason: "network" });
        }
      })();
      return true; // async response

    case "GET_FILTER_RATING_STATS":
      // Public aggregate ratings for a batch of video keys. Used by the side
      // panel (one key) and the YouTube thumbnail badges (many). Routed through
      // the SW so its host permission bypasses CORS for the cross-origin call.
      (async () => {
        const keys = Array.isArray(message.keys) ? message.keys : [];
        if (keys.length === 0) {
          sendResponse({ ok: true, stats: {} });
          return;
        }
        const { websiteUrl } = await chrome.storage.local.get({
          websiteUrl: "https://karafilt.com",
        });
        const base = (websiteUrl || "").trim().replace(/\/+$/, "");
        if (!base) {
          sendResponse({ ok: false, stats: {} });
          return;
        }
        try {
          const res = await fetchWithTimeout(
            `${base}/api/filter-ratings/stats`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({ keys }),
            },
            8000,
          );
          if (res.ok) {
            const data = await res.json();
            sendResponse({ ok: true, stats: data.stats || {} });
          } else {
            sendResponse({ ok: false, status: res.status, stats: {} });
          }
        } catch {
          sendResponse({ ok: false, error: "network", stats: {} });
        }
      })();
      return true; // async response

    case "GET_MY_FILTER_RATING":
      // The signed-in user's current rating for one video key, so the side panel
      // can pre-fill the widget ("you've already rated this"). Cookie-carrying
      // fetch like SUBMIT_FILTER_RATING; routed through the SW to bypass CORS.
      (async () => {
        const videoKey =
          typeof message.videoKey === "string" ? message.videoKey : null;
        if (!videoKey) {
          sendResponse({ ok: false, rating: null });
          return;
        }
        const { websiteUrl } = await chrome.storage.local.get({
          websiteUrl: "https://karafilt.com",
        });
        const base = (websiteUrl || "").trim().replace(/\/+$/, "");
        if (!base) {
          sendResponse({ ok: false, rating: null });
          return;
        }
        try {
          const res = await fetchWithTimeout(
            `${base}/api/filter-ratings/mine`,
            {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({ videoKey }),
            },
            8000,
          );
          if (res.ok) {
            const data = await res.json();
            sendResponse({
              ok: true,
              rating: data.rating ?? null,
              liked: typeof data.liked === "boolean" ? data.liked : null,
              comment: data.comment ?? null,
            });
          } else {
            sendResponse({ ok: false, status: res.status, rating: null });
          }
        } catch {
          sendResponse({ ok: false, error: "network", rating: null });
        }
      })();
      return true; // async response

    case "PARTY_PING":
      // Liveness check from the party page's content-script bridge.
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;

    case "PARTY_GET_STATUS":
      // Live filter status for the party page's on-page panel. thisTab tells the
      // page whether THIS player tab is the one being filtered. Await recovery:
      // this message may be the event that woke an evicted SW, and the fresh
      // in-memory capturedTabId (null) would lie "filter off" mid-party.
      (async () => {
        await captureStateReady;
        const onThisTab = !!(sender.tab && sender.tab.id === capturedTabId);
        sendResponse({
          installed: true,
          filtering: capturedTabId !== null,
          thisTab: onThisTab,
          mode: currentMode,
          mix: currentMix,
        });
      })();
      return true; // async response

    case "PARTY_SET_MODE":
      // Control the already-running filter from the party page (mode). Guarded so
      // the page can only change the filter on its own tab.
      (async () => {
        await captureStateReady;
        const onThisTab = !!(sender.tab && sender.tab.id === capturedTabId);
        if (onThisTab && typeof message.value === "string") setFilterMode(message.value);
        sendResponse({ ok: onThisTab, mode: currentMode });
      })();
      return true; // async response

    case "PARTY_SET_MIX":
      (async () => {
        await captureStateReady;
        const onThisTab = !!(sender.tab && sender.tab.id === capturedTabId);
        if (onThisTab && typeof message.value === "number") setFilterMix(message.value);
        sendResponse({ ok: onThisTab, mix: currentMix });
      })();
      return true; // async response

    case "PARTY_START_FILTER":
      // Start the filter on the party page's own tab, from its on-page button.
      // A page click is not an extension invocation, so getMediaStreamId only
      // succeeds when the user has invoked the extension on this tab before
      // (shortcut / context menu / side panel); when it throws we fall back to
      // the getDisplayMedia picker — the same path Brave side-panel clicks use.
      // The picker path replies ok BEFORE the user finishes the dialog; a
      // cancel rolls the state back via DISPLAY_MEDIA_FAILED below.
      (async () => {
        await captureStateReady;
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) {
          sendResponse({ ok: false, error: "no_tab" });
          return;
        }
        if (capturedTabId === tabId) {
          sendResponse({ ok: true, already: true });
          return;
        }
        let started = false;
        try {
          const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
          const result = await handleStartCapture(tabId, streamId);
          started = !!(result && result.success);
          if (started) sendResponse({ ok: true, via: "tabCapture" });
        } catch (err) {
          dbg("[SW] PARTY_START_FILTER: tabCapture path unavailable:", err && err.message);
        }
        if (!started) {
          const result = await handleStartCaptureViaDisplayMedia(tabId);
          started = !!(result && result.success);
          sendResponse({ ok: started, via: "displayMedia" });
        }
        if (started) {
          chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: true }).catch(() => {});
        }
      })();
      return true; // async response

    case "PARTY_STOP_FILTER":
      // Stop the filter from the party page's status badge. Unlike starting,
      // stopping needs no gesture/invocation — mirrors the "already capturing"
      // branch of toggleCaptureForTab, guarded to the page's own tab.
      (async () => {
        await captureStateReady;
        const onThisTab = !!(sender.tab && sender.tab.id === capturedTabId);
        if (onThisTab) {
          flushUsage(Date.now());
          setCapturedTab(null, null);
          chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
          chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
        }
        sendResponse({ ok: onThisTab });
      })();
      return true; // async response

    case "DISPLAY_MEDIA_FAILED":
      // The offscreen document's getDisplayMedia was cancelled (or returned no
      // audio track) — roll back the capture state that
      // handleStartCaptureViaDisplayMedia set optimistically, so status stops
      // claiming the filter is on.
      flushUsage(Date.now());
      setCapturedTab(null, null);
      chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
      return false;

    case "CREATE_PARTY":
      // Host starts a party. POST /api/party/create with the site session cookie
      // (same auth path as GET_ACCOUNT_STATUS). On success: remember the room in
      // storage.session, open the host player tab, and return code + joinUrl so
      // the panel can render the QR. The player page never navigates between
      // songs, so the user's tab-audio capture survives the whole party.
      (async () => {
        const { websiteUrl } = await chrome.storage.local.get({
          websiteUrl: "https://karafilt.com",
        });
        const base = (websiteUrl || "").trim().replace(/\/+$/, "");
        if (!base) {
          sendResponse({ ok: false, error: "no_site" });
          return;
        }
        try {
          const res = await fetchWithTimeout(
            `${base}/api/party/create`,
            {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({ name: message.name || null }),
            },
            8000,
          );
          if (!res.ok) {
            sendResponse({ ok: false, status: res.status, loginUrl: `${base}/login` });
            return;
          }
          const data = await res.json();
          const room = { code: data.code, joinUrl: data.joinUrl, hostTabId: null };
          // Open the player tab with ?host=1 so it renders the host player; the
          // bare joinUrl (the QR target) always opens the guest add-a-song view.
          const playerUrl =
            data.joinUrl + (data.joinUrl.includes("?") ? "&" : "?") + "host=1";
          try {
            const tab = await chrome.tabs.create({ url: playerUrl, active: true });
            room.hostTabId = tab.id ?? null;
          } catch {}
          await chrome.storage.session.set({ partyRoom: room });
          sendResponse({ ok: true, ...room });
        } catch {
          sendResponse({ ok: false, error: "network" });
        }
      })();
      return true; // async response

    case "GET_PARTY":
      // Restore the active party so the panel can re-render the QR after reopen.
      chrome.storage.session.get({ partyRoom: null }, ({ partyRoom }) => {
        sendResponse({ partyRoom });
      });
      return true; // async response

    case "GET_PARTY_COUNT":
      // Live "N in queue" for the panel. Anonymous read of the room state; routed
      // through the SW so its host permission covers the cross-origin call.
      (async () => {
        const code = typeof message.code === "string" ? message.code : null;
        if (!code) {
          sendResponse({ ok: false });
          return;
        }
        const { websiteUrl } = await chrome.storage.local.get({
          websiteUrl: "https://karafilt.com",
        });
        const base = (websiteUrl || "").trim().replace(/\/+$/, "");
        if (!base) {
          sendResponse({ ok: false });
          return;
        }
        try {
          const res = await fetchWithTimeout(
            `${base}/api/party/${encodeURIComponent(code)}/state`,
            { headers: { Accept: "application/json" } },
            8000,
          );
          if (res.ok) {
            const data = await res.json();
            sendResponse({
              ok: true,
              found: data.found,
              status: data.status,
              count: data.count ?? 0,
              nowPlaying: data.nowPlaying ?? null,
            });
          } else {
            sendResponse({ ok: false, status: res.status });
          }
        } catch {
          sendResponse({ ok: false, error: "network" });
        }
      })();
      return true; // async response

    case "END_PARTY":
      // Clear the panel's local pointer to the party. (The room itself is closed
      // from the player page's "End party" control.)
      chrome.storage.session.remove("partyRoom", () => {
        sendResponse({ ok: true });
      });
      return true; // async response
  }
});

// Stop capture when the captured tab navigates to a different page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === capturedTabId && changeInfo.url) {
    // Compare only origin + pathname to ignore query/hash changes (e.g. YouTube &t= params)
    try {
      const oldUrl = new URL(capturedTabUrl);
      const newUrl = new URL(changeInfo.url);
      if (oldUrl.origin + oldUrl.pathname !== newUrl.origin + newUrl.pathname) {
        dbg("Tab navigated away, stopping capture:", changeInfo.url);
        flushUsage(Date.now());
        setCapturedTab(null, null);
        chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
        chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
      } else {
        // Same page, query/hash change. On YouTube the next video keeps /watch
        // but swaps ?v= — that's a new song, so re-segment usage.
        setCapturedTab(capturedTabId, changeInfo.url);
        if (currentUsage) {
          const newKey = deriveVideoKey(changeInfo.url);
          if (newKey && newKey !== currentUsage.videoKey) {
            flushUsage(Date.now());
            openUsage(changeInfo.url, currentMode);
          }
        }
      }
    } catch (e) {
      // If URL parsing fails, stop capture to be safe
      flushUsage(Date.now());
      setCapturedTab(null, null);
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    }
  }
});

// Sign-in round-trip: the side panel opens /login in a popup window via
// OPEN_LOGIN; when that page lands on /account (the post-login redirect),
// close the popup and refocus the tab the user came from. The panel is still
// visible there and its account chip refreshes via the focus/visibility
// hooks. State lives in storage.session so an idle SW restart mid-login
// doesn't lose it.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const { loginWatch } = await chrome.storage.session.get({ loginWatch: null });
  if (!loginWatch || tabId !== loginWatch.loginTabId) return;
  let path;
  try {
    path = new URL(changeInfo.url).pathname;
  } catch {
    return;
  }
  if (path !== "/account") return;
  await chrome.storage.session.set({ loginWatch: null });
  if (loginWatch.loginWindowId != null) {
    chrome.windows.remove(loginWatch.loginWindowId).catch(() => {});
  } else {
    chrome.tabs.remove(tabId).catch(() => {});
  }
  // The panel stayed visible the whole time (popup floats above it), so no
  // visibilitychange fires — tell it explicitly to re-check the session.
  chrome.runtime.sendMessage({ type: "ACCOUNT_CHANGED" }).catch(() => {});
  if (loginWatch.returnTabId != null) {
    try {
      const ret = await chrome.tabs.get(loginWatch.returnTabId);
      await chrome.tabs.update(ret.id, { active: true });
      chrome.windows.update(ret.windowId, { focused: true }).catch(() => {});
    } catch {
      // The original tab is gone — nothing to return to.
    }
  }
});

// Stop capture when the captured tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  // Clear the panel binding when its tab closes (the panel dies with the tab).
  chrome.storage.session.get({ boundTabId: null }, ({ boundTabId }) => {
    if (boundTabId === tabId) chrome.storage.session.set({ boundTabId: null });
  });
  // Abandoned sign-in: user closed the login tab themselves — stop watching.
  chrome.storage.session.get({ loginWatch: null }, ({ loginWatch }) => {
    if (loginWatch && loginWatch.loginTabId === tabId) {
      chrome.storage.session.set({ loginWatch: null });
    }
  });
  if (tabId === capturedTabId) {
    flushUsage(Date.now());
    setCapturedTab(null, null);
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
  }
});

// Cross-browser fallback when the side-panel button can't grant the activeTab
// gesture tabCapture needs (Brave/Edge/Vivaldi). The offscreen document calls
// navigator.mediaDevices.getDisplayMedia() instead, which shows the browser's
// "Choose what to share" picker. The user selects the tab, checks "Share
// audio", and capture proceeds through the same post-stream pipeline as the
// tabCapture path.
async function handleStartCaptureViaDisplayMedia(tabId) {
  try {
    if (capturedTabId !== null) {
      flushUsage(Date.now());
      setCapturedTab(null, null);
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      await new Promise((r) => setTimeout(r, 300));
    }
    const tab = await chrome.tabs.get(tabId);
    await ensureOffscreenDocument();

    setCapturedTab(tabId, tab.url);
    openUsage(tab.url, currentMode);
    dbg("[SW] sending START_VIA_DISPLAY_MEDIA, mode:", currentMode);
    chrome.runtime.sendMessage({
      type: "START_VIA_DISPLAY_MEDIA",
      mode: currentMode,
      tabId,
    });
    return { success: true };
  } catch (err) {
    console.error("[SW] handleStartCaptureViaDisplayMedia failed:", err);
    return { success: false, error: err.message };
  }
}

async function handleStartCapture(tabId, providedStreamId) {
  try {
    // Stop any existing capture first
    if (capturedTabId !== null) {
      flushUsage(Date.now());
      setCapturedTab(null, null);
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      // Give the offscreen document time to release the stream
      await new Promise(r => setTimeout(r, 300));
    }

    const tab = await chrome.tabs.get(tabId);
    dbg("[SW] tab URL:", tab.url);

    await ensureOffscreenDocument();
    dbg("[SW] offscreen document ready");

    // Prefer the streamId captured by the side panel click handler — that path
    // keeps the activeTab user gesture intact. Fall back to fetching one here
    // for legacy callers; that path will fail with "Extension has not been
    // invoked for the current page" if the user hasn't re-invoked the extension
    // on this tab recently.
    const streamId = providedStreamId || await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });
    dbg("[SW] got stream ID:", streamId, providedStreamId ? "(from caller)" : "(fetched in SW)");

    // Send stream ID along with current mode so it's applied after capture starts
    setCapturedTab(tabId, tab.url);
    openUsage(tab.url, currentMode);

    dbg("[SW] sending STREAM_READY, mode:", currentMode);
    chrome.runtime.sendMessage({
      type: "STREAM_READY",
      streamId: streamId,
      mode: currentMode,
      tabId,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to start capture:", err);
    return { success: false, error: err.message };
  }
}

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  // If a creation is already in progress, wait for it
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  // Check if one already exists (getContexts may not exist in all browsers)
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length > 0) {
      offscreenReady = true;
      return;
    }
  }

  // Try to create — if it already exists, catch and ignore
  try {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      // DISPLAY_MEDIA is needed for the cross-browser fallback path
      // (offscreen calls navigator.mediaDevices.getDisplayMedia). USER_MEDIA
      // covers the Chrome-friendly tabCapture path that uses getUserMedia.
      reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
      justification: "Capture tab audio for real-time vocal removal processing",
    });
    await creatingOffscreen;
  } catch (e) {
    if (!e.message.includes("single offscreen document")) {
      throw e;
    }
    // Already exists — that's fine
  }

  offscreenReady = true;
  creatingOffscreen = null;
}
