// Shared song-matching core (title cleaning, candidate scoring, LRCLib request
// building). importScripts runs synchronously and populates self.KarafiltSongMatch.
importScripts("shared/song-match.js");
const SM = self.KarafiltSongMatch;
const { normalizeForMatch, levenshtein, fuzzyTrackMatch } = SM;

// Set to true for verbose console logging during development.
const KF_DEBUG = false;
const dbg = (...args) => { if (KF_DEBUG) dbg(...args); };

let offscreenReady = false;
let currentMode = "stft";
let capturedTabId = null;
let capturedTabUrl = null;
let currentAIStatus = { status: "idle", detail: null };

// Icon click opens the side panel only — it does NOT auto-start capture.
// Starting capture requires an explicit user action (Start button in Chrome,
// or the Ctrl+Shift+K shortcut in any Chromium browser).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[SW] setPanelBehavior failed:", err));

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
    capturedTabId = null;
    capturedTabUrl = null;
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
    chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
    return;
  }
  chrome.tabCapture
    .getMediaStreamId({ targetTabId: tab.id })
    .then(async (streamId) => {
      const result = await handleStartCapture(tab.id, undefined, streamId);
      if (result && result.success) {
        chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: true }).catch(() => {});
      }
    })
    .catch((err) => {
      console.error("[SW] toggleCaptureForTab: tabCapture failed:", err && err.message);
    });
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
  if (tab && tab.id) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
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
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
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

  return fetchFromLRCLib(artist, track, { lrclibOnly, forceRefresh, skipLrclib, durationSec, album });
}

function cacheKey(artist, track) {
  return `${(artist || "").toLowerCase()}|${(track || "").toLowerCase()}`;
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
    const matching = songHits
      .filter((h) => fuzzyTrackMatch(h.title, track))
      .map((h) => ({ ...h, dist: levenshtein(normalizeForMatch(h.title), wanted) }))
      .sort((a, b) => a.dist - b.dist);

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
        source: "lyrics.ovh",
      };
    }
  } catch (err) {
    console.error("[SW] Lyrics.ovh fetch failed:", err);
  }
  return { found: false };
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
  const key = cacheKey(artist, track);
  if (!forceRefresh && lyricsCache.has(key)) return lyricsCache.get(key);

  let result = { found: false };
  // lrclibOnly + skipLrclib leaves nothing to do — a clean miss.
  if (lrclibOnly && skipLrclib) return result;

  const t0 = performance.now();
  let lrclibMs = 0;
  if (!skipLrclib) {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle AI_STATUS / AI_LAG / seek messages from the offscreen document
  if (sender.url && sender.url.includes("offscreen.html")) {
    if (message.type === "AI_STATUS") {
      currentAIStatus = { status: message.status, detail: message.detail || null };
      // Re-broadcast so the popup receives it
      chrome.runtime.sendMessage(message).catch(() => {});
    } else if (message.type === "AI_LAG") {
      // Re-broadcast the AI playback-lag value to the side panel so it can
      // shift the lyric highlight to match the delayed backend audio.
      chrome.runtime.sendMessage(message).catch(() => {});
    } else if (message.type === "MEDIA_SEEK_RELATIVE") {
      // Forward the AI sync seek request to the captured tab's content
      // script, which is the only context that can poke the <video> element.
      if (capturedTabId !== null) {
        chrome.tabs.sendMessage(capturedTabId, message).catch(() => {});
      }
    }
    return;
  }

  dbg("[SW] received message:", message.type, "from:", sender.url || "unknown");

  switch (message.type) {
    case "START_CAPTURE":
      if (message.mode) currentMode = message.mode;
      dbg("[SW] START_CAPTURE mode:", currentMode, "tabId:", message.tabId);
      handleStartCapture(message.tabId, message.aiModel, message.streamId).then((result) => {
        // Broadcast capture state so popup AND side panel both reflect it.
        if (result && result.success) {
          chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: true }).catch(() => {});
        }
        sendResponse(result);
      });
      return true; // async response

    case "START_CAPTURE_DISPLAY_MEDIA":
      if (message.mode) currentMode = message.mode;
      dbg("[SW] START_CAPTURE_DISPLAY_MEDIA mode:", currentMode, "tabId:", message.tabId);
      handleStartCaptureViaDisplayMedia(message.tabId, message.aiModel).then((result) => {
        if (result && result.success) {
          chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: true }).catch(() => {});
        }
        sendResponse(result);
      });
      return true; // async response

    case "STOP_CAPTURE":
      dbg("[SW] STOP_CAPTURE received, forwarding to offscreen");
      capturedTabId = null;
      capturedTabUrl = null;
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
      break;

    case "SET_MIX":
      chrome.runtime.sendMessage({ type: "SET_MIX", value: message.value });
      break;

    case "SET_MODE":
      currentMode = message.value;
      if (isAIMode(message.value)) {
        // Switching to AI mid-session: fetch a filter token first (if a Website
        // URL is configured) and push it before the offscreen WS reconnects.
        resolveAuthToken(message.value, null).then((r) => {
          if (r.gated) {
            currentMode = "stft";
            broadcastAIGated(r.gated);
            chrome.runtime.sendMessage({ type: "SET_MODE", value: "stft" });
          } else {
            if (r.token) chrome.runtime.sendMessage({ type: "SET_API_KEY", value: r.token });
            chrome.runtime.sendMessage({ type: "SET_MODE", value: message.value });
          }
        });
      } else {
        chrome.runtime.sendMessage({ type: "SET_MODE", value: message.value });
      }
      break;

    case "SET_AI_MODEL":
      chrome.runtime.sendMessage({ type: "SET_AI_MODEL", value: message.value });
      break;

    case "SET_SERVER_URL":
      chrome.runtime.sendMessage({ type: "SET_SERVER_URL", value: message.value });
      break;

    case "SET_API_KEY":
      chrome.runtime.sendMessage({ type: "SET_API_KEY", value: message.value });
      break;

    case "FETCH_LYRICS": {
      const tabId = sender.tab ? sender.tab.id : null;
      handleFetchLyrics(message.artist, message.track, tabId, {
        lrclibOnly: !!message.lrclibOnly,
        forceRefresh: !!message.forceRefresh,
        skipLrclib: !!message.skipLrclib,
        durationSec: message.durationSec || 0,
        album: message.album || "",
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

    case "GET_AI_MODELS":
      (async () => {
        await ensureOffscreenDocument();
        const settings = await chrome.storage.local.get({
          serverUrl: "",
          apiKey: "",
        });
        chrome.runtime.sendMessage({
          type: "GET_AI_MODELS",
          serverUrl: settings.serverUrl,
          apiKey: settings.apiKey,
        }, sendResponse);
      })();
      return true; // async response

    case "GET_STATE":
      sendResponse({ isActive: capturedTabId !== null, aiStatus: currentAIStatus });
      return false;
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
        capturedTabId = null;
        capturedTabUrl = null;
        chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
        chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
      } else {
        // Update stored URL but don't stop capture
        capturedTabUrl = changeInfo.url;
      }
    } catch (e) {
      // If URL parsing fails, stop capture to be safe
      capturedTabId = null;
      capturedTabUrl = null;
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    }
  }
});

// Stop capture when the captured tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === capturedTabId) {
    capturedTabId = null;
    capturedTabUrl = null;
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: false }).catch(() => {});
  }
});

// Cross-browser fallback when the side-panel button can't grant the
// activeTab gesture tabCapture needs (Brave/Edge/Vivaldi). The offscreen
// document calls navigator.mediaDevices.getDisplayMedia() instead, which
// ── Phase 5: Pro account / filter-token gating ──────────────────────────────
// When a Website URL is configured AND an AI mode is requested, fetch a
// short-lived filter token from the website and use it as the backend auth
// token. Defaults to the production site; clearing the field in Settings
// disables gating entirely (local/self-hosted use — static apiKey only).
// Keep the default in sync with DEFAULTS.websiteUrl in shared/controls-bindings.js.
function isAIMode(m) {
  return m === "ai" || m === "ai2";
}

async function getFilterToken() {
  const { websiteUrl } = await chrome.storage.local.get({ websiteUrl: "https://karafilt.com" });
  const base = (websiteUrl || "").trim().replace(/\/+$/, "");
  if (!base) return { disabled: true };
  try {
    const res = await fetchWithTimeout(
      `${base}/api/filter-token`,
      { method: "POST", credentials: "include", headers: { Accept: "application/json" } },
      8000,
    );
    if (res.ok) {
      const data = await res.json();
      return { ok: true, token: data.token, entitlement: data.entitlement };
    }
    let reason = null;
    try { reason = (await res.json()).reason; } catch {}
    return { ok: false, status: res.status, reason };
  } catch {
    return { ok: false, status: 0, reason: "network" };
  }
}

// Resolve the backend auth token for a capture. For AI modes with a configured
// website this is the filter token; otherwise the static apiKey. Returns
// { token } on success, or { token, gated } when AI is requested but blocked.
async function resolveAuthToken(mode, apiKey) {
  if (!isAIMode(mode)) return { token: apiKey };
  const r = await getFilterToken();
  if (r.disabled) return { token: apiKey };   // gating off — legacy behaviour
  if (r.ok) return { token: r.token };
  const reason =
    r.status === 401 ? "signin" :
    r.status === 403 ? "verify_email" :
    r.status === 402 ? (r.reason || "subscribe") :
    "network";
  return { token: apiKey, gated: reason };
}

function broadcastAIGated(reason) {
  const messages = {
    signin: "Sign in on the website to use AI filtering",
    verify_email: "Verify your email to use AI filtering",
    subscribe: "Subscribe to use AI filtering",
    no_subscription: "Subscribe to use AI filtering",
    trial_exhausted: "Free trial used up — subscribe for AI filtering",
    trial_expired: "Trial period ended — subscribe for AI filtering",
    network: "Can't reach the account server — using free mode",
  };
  const detail = messages[reason] || "AI filtering unavailable — using free mode";
  chrome.runtime.sendMessage({ type: "AI_STATUS", status: "gated", detail }).catch(() => {});
}

// shows the browser's "Choose what to share" picker. The user selects the
// tab, checks "Share audio", and capture proceeds through the same
// post-stream pipeline as the tabCapture path.
async function handleStartCaptureViaDisplayMedia(tabId, aiModel) {
  try {
    if (capturedTabId !== null) {
      capturedTabId = null;
      capturedTabUrl = null;
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      await new Promise((r) => setTimeout(r, 300));
    }
    const tab = await chrome.tabs.get(tabId);
    await ensureOffscreenDocument();
    const settings = await chrome.storage.local.get({
      serverUrl: "",
      apiKey: "",
    });

    // Phase 5: filter token for AI modes (see handleStartCapture).
    let authToken = settings.apiKey;
    if (isAIMode(currentMode)) {
      const r = await resolveAuthToken(currentMode, settings.apiKey);
      if (r.gated) { currentMode = "stft"; broadcastAIGated(r.gated); }
      else authToken = r.token;
    }

    capturedTabId = tabId;
    capturedTabUrl = tab.url;
    dbg("[SW] sending START_VIA_DISPLAY_MEDIA, mode:", currentMode, "aiModel:", aiModel);
    chrome.runtime.sendMessage({
      type: "START_VIA_DISPLAY_MEDIA",
      mode: currentMode,
      aiModel: aiModel,
      serverUrl: settings.serverUrl,
      apiKey: authToken,
    });
    return { success: true };
  } catch (err) {
    console.error("[SW] handleStartCaptureViaDisplayMedia failed:", err);
    return { success: false, error: err.message };
  }
}

async function handleStartCapture(tabId, aiModel, providedStreamId) {
  try {
    // Stop any existing capture first
    if (capturedTabId !== null) {
      capturedTabId = null;
      capturedTabUrl = null;
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      // Give the offscreen document time to release the stream
      await new Promise(r => setTimeout(r, 300));
    }

    const tab = await chrome.tabs.get(tabId);
    dbg("[SW] tab URL:", tab.url);

    await ensureOffscreenDocument();
    dbg("[SW] offscreen document ready");

    // Push current settings to the offscreen document (it can't access chrome.storage)
    const settings = await chrome.storage.local.get({
      serverUrl: "",
      apiKey: "",
    });

    // Phase 5: for AI modes with a configured Website URL, fetch a filter token
    // and use it as the backend auth token; otherwise use the static apiKey. If
    // AI is requested but not entitled, fall back to free spectral mode.
    let authToken = settings.apiKey;
    if (isAIMode(currentMode)) {
      const r = await resolveAuthToken(currentMode, settings.apiKey);
      if (r.gated) { currentMode = "stft"; broadcastAIGated(r.gated); }
      else authToken = r.token;
    }

    // Prefer the streamId captured by the side panel/popup click handler —
    // that path keeps the activeTab user gesture intact. Fall back to
    // fetching one here for legacy callers; that path will fail with
    // "Extension has not been invoked for the current page" if the user
    // hasn't re-invoked the extension on this tab recently.
    const streamId = providedStreamId || await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });
    dbg("[SW] got stream ID:", streamId, providedStreamId ? "(from caller)" : "(fetched in SW)");

    // Send stream ID along with current mode so it's applied after capture starts
    capturedTabId = tabId;
    capturedTabUrl = tab.url;

    dbg("[SW] sending STREAM_READY, mode:", currentMode, "aiModel:", aiModel);
    chrome.runtime.sendMessage({
      type: "STREAM_READY",
      streamId: streamId,
      mode: currentMode,
      aiModel: aiModel,
      serverUrl: settings.serverUrl,
      apiKey: authToken,
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
