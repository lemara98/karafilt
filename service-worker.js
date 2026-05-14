let offscreenReady = false;
let currentMode = "stft";
let capturedTabId = null;
let capturedTabUrl = null;
let currentAIStatus = { status: "idle", detail: null };

// In-memory cache for LRCLib lookups — keeps us from hammering the API
// on title-watchers that fire multiple times per page.
const lyricsCache = new Map();
const LYRICS_CACHE_MAX = 50;

// Smart-sync (forced alignment) state
const alignmentInProgress = new Set();   // song keys currently being aligned
const alignTabBySongKey = new Map();      // songKey → tabId that initiated the alignment
const ALIGN_STORAGE_PREFIX = "align:";

async function getAlignedFromStorage(songKey) {
  const storageKey = ALIGN_STORAGE_PREFIX + songKey;
  const obj = await chrome.storage.local.get([storageKey]);
  const v = obj[storageKey];
  return Array.isArray(v) && v.length > 0 ? v : null;
}

async function setAlignedInStorage(songKey, lines) {
  await chrome.storage.local.set({ [ALIGN_STORAGE_PREFIX + songKey]: lines });
}

async function maybeStartAlignment({ tabId, songKey, lyrics }) {
  if (!songKey || !lyrics) return;
  if (alignmentInProgress.has(songKey)) return;
  // Alignment requires the audio capture pipeline to be running on THIS tab —
  // offscreen only has a live audio source for the captured tab. If capture
  // isn't active or is bound to a different tab, smart sync silently no-ops.
  if (capturedTabId === null) return;
  if (tabId != null && tabId !== capturedTabId) return;
  // Already cached? skip.
  const existing = await getAlignedFromStorage(songKey);
  if (existing) return;

  alignmentInProgress.add(songKey);
  alignTabBySongKey.set(songKey, tabId);
  const settings = await chrome.storage.local.get({
    serverUrl: "ws://localhost:9876",
    apiKey: "",
  });
  console.log(`[SW][align] starting alignment for ${songKey} on tab ${tabId}`);
  chrome.runtime.sendMessage({
    type: "START_ALIGNMENT",
    songKey,
    lyrics,
    tabId,
    serverUrl: settings.serverUrl,
    apiKey: settings.apiKey,
  }).catch(() => {});
  // Inform the content script so it can surface an "Aligning..." status
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, {
      type: "ALIGN_STATUS",
      songKey,
      status: "aligning",
    }).catch(() => {});
  }
}

// Wraps the LRCLib chain with a smart-sync cache lookup and a
// fire-and-forget alignment kick-off when only plain lyrics are available.
//
// opts.lrclibOnly: skip Lyrics.ovh + Genius fallbacks (used during phase 1
//   of the content-script's two-phase loop, so we only pay for fast LRCLib
//   API calls across all candidates).
// opts.forceRefresh: bypass the in-memory lyricsCache and the smart-sync
//   cache (used by the manual Refresh button).
async function handleFetchLyrics(artist, track, tabId, opts) {
  const lrclibOnly = !!(opts && opts.lrclibOnly);
  const forceRefresh = !!(opts && opts.forceRefresh);
  const songKey = cacheKey(artist, track);

  // Cache hit: return the previously aligned synced lines directly. Skipped
  // when forceRefresh is set so the user can override a stale cached result.
  if (!forceRefresh) {
    const cached = await getAlignedFromStorage(songKey);
    if (cached) {
      return {
        found: true,
        syncedLyrics: null,
        syncedLines: cached,
        plainLyrics: null,
        source: "smart-sync (cached)",
      };
    }
  }

  const result = await fetchFromLRCLib(artist, track, { lrclibOnly, forceRefresh });

  // If we got plain text only, fire alignment in the background. syncedLyrics
  // already covers the synced case; no need to align.
  const isPlainOnly = result.found && !result.syncedLyrics && result.plainLyrics;
  if (isPlainOnly && tabId != null) {
    maybeStartAlignment({ tabId, songKey, lyrics: result.plainLyrics }).catch(() => {});
  }

  return result;
}

function handleAlignResult(message) {
  const songKey = message.songKey;
  if (!songKey) return;
  alignmentInProgress.delete(songKey);
  const tabId = message.tabId != null ? message.tabId : alignTabBySongKey.get(songKey);
  alignTabBySongKey.delete(songKey);

  if (message.ok && Array.isArray(message.lines) && message.lines.length > 0) {
    setAlignedInStorage(songKey, message.lines).catch((err) => {
      console.warn("[SW][align] failed to cache result:", err);
    });
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, {
        type: "LYRICS_UPGRADE",
        songKey,
        lines: message.lines,
      }).catch(() => {});
    }
    console.log(`[SW][align] alignment complete for ${songKey}: ${message.lines.length} lines`);
  } else {
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, {
        type: "ALIGN_STATUS",
        songKey,
        status: "failed",
        error: message.error || "unknown",
      }).catch(() => {});
    }
    console.log(`[SW][align] alignment failed for ${songKey}:`, message.error);
  }
}

function cacheKey(artist, track) {
  return `${(artist || "").toLowerCase()}|${(track || "").toLowerCase()}`;
}

// ── Fuzzy track-name matching ──────────────────────────────────────────────
// Used to verify that a result returned by LRCLib's free-text search is
// actually the song we asked about. Without this, /api/search can return any
// loosely-related song first when the title is messy (e.g. comma-separated
// artists, capitalization mismatches, diacritics).

function normalizeForMatch(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // strip diacritics (ć→c, ž→z, …)
    .replace(/[^a-z0-9]+/g, " ")        // collapse non-alphanumeric to spaces
    .trim();
}

// Iterative Levenshtein with two rolling rows. Sufficient for short song
// titles (<200 chars).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let v0 = new Array(b.length + 1);
  let v1 = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) v0[j] = j;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    [v0, v1] = [v1, v0];
  }
  return v0[b.length];
}

function fuzzyTrackMatch(candidate, requested) {
  const a = normalizeForMatch(candidate);
  const b = normalizeForMatch(requested);
  if (!a || !b) return false;
  if (a === b) return true;
  // Allow edits up to 15% of the longer string (min 2). Catches typos,
  // missing/extra "the", "a remix", etc., while rejecting wholly different songs.
  const tolerance = Math.max(2, Math.floor(Math.max(a.length, b.length) * 0.15));
  return levenshtein(a, b) <= tolerance;
}

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
    const res = await fetch(url);
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
    const sres = await fetch(searchUrl, { headers: { "Accept": "application/json" } });
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

    // Fetch primary + up to 3 alternative pages in parallel so the side panel
    // can offer the user a "wrong song?" picker without extra round trips.
    const fetched = await Promise.all(
      matching.slice(0, 4).map(async (h) => ({
        h,
        lyrics: await fetchGeniusPageLyrics(h.url),
      }))
    );
    const usable = fetched.filter((x) => x.lyrics);
    if (usable.length === 0) return { found: false };

    const primary = usable[0];
    const alternatives = usable.slice(1).map((x) => ({
      trackName: x.h.title,
      artistName: x.h.artist,
      syncedLyrics: null,
      plainLyrics: x.lyrics,
      source: "genius",
    }));

    return {
      found: true,
      syncedLyrics: null,
      plainLyrics: primary.lyrics,
      trackName: primary.h.title,
      artistName: primary.h.artist,
      source: "genius",
      alternatives,
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
    const res = await fetch(url);
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
  const key = cacheKey(artist, track);
  if (!forceRefresh && lyricsCache.has(key)) return lyricsCache.get(key);

  let result = { found: false };
  try {
    // Fire /api/get (exact pair) and /api/search (free-text) in parallel,
    // then merge. We can't trust /api/get alone: it'll happily return the
    // plain version of a song even when a synced version exists under a
    // slightly different artist/track spelling. Running both concurrently
    // costs the same wall-clock as the slower one (~400ms) and gives us the
    // full set of fuzzy matches to score from.
    const getPromise = (artist && track)
      ? (async () => {
          const params = new URLSearchParams();
          params.set("artist_name", artist);
          params.set("track_name", track);
          const r = await fetch(`https://lrclib.net/api/get?${params.toString()}`);
          if (!r.ok) return null;
          return await r.json();
        })()
      : Promise.resolve(null);

    const searchPromise = (async () => {
      const q = artist ? `${track} ${artist}` : track;
      const r = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) return [];
      return await r.json();
    })();

    const [getData, searchArr] = await Promise.all([getPromise, searchPromise]);

    // Merge + dedupe candidates. Both endpoints sometimes return the same row;
    // dedupe by (artistName, trackName) so it doesn't appear twice in the
    // alternatives list.
    const candidates = [];
    const seen = new Set();
    const addCandidate = (r) => {
      if (!r) return;
      if (!r.syncedLyrics && !r.plainLyrics) return;
      if (!fuzzyTrackMatch(r.trackName, track)) return;
      const k = `${(r.artistName || "").toLowerCase()}|${(r.trackName || "").toLowerCase()}`;
      if (seen.has(k)) return;
      seen.add(k);
      candidates.push(r);
    };
    // /api/get result first — it's the highest-confidence match by definition.
    // /api/search hits follow; the sort below promotes synced versions over
    // plain regardless of which endpoint surfaced them.
    addCandidate(getData);
    if (Array.isArray(searchArr)) {
      for (const r of searchArr) addCandidate(r);
    }

    if (candidates.length > 0) {
      const wanted = normalizeForMatch(track);
      const scored = candidates
        .map((r) => ({
          r,
          dist: levenshtein(normalizeForMatch(r.trackName), wanted),
          synced: !!r.syncedLyrics,
        }))
        // Synced first (always), then closest track-name match.
        .sort((a, b) => {
          if (a.synced !== b.synced) return a.synced ? -1 : 1;
          return a.dist - b.dist;
        });

      const best = scored[0].r;
      result = {
        found: true,
        syncedLyrics: best.syncedLyrics || null,
        plainLyrics: best.plainLyrics || null,
        trackName: best.trackName,
        artistName: best.artistName,
        source: "lrclib",
        alternatives: scored.slice(1, 6).map((s) => ({
          trackName: s.r.trackName,
          artistName: s.r.artistName,
          syncedLyrics: s.r.syncedLyrics || null,
          plainLyrics: s.r.plainLyrics || null,
          source: "lrclib",
        })),
      };
    }
  } catch (err) {
    console.error("[SW] LRCLib fetch failed:", err);
  }

  // Skip the heavyweight fallbacks during phase 1 of the content-script's
  // two-phase loop — Genius alone takes ~3-5s per candidate, which adds up
  // to ~30s when LRCLib misses on every candidate.
  if (!lrclibOnly) {
    // If LRCLib found nothing, try Lyrics.ovh as a secondary source.
    // Lyrics.ovh requires both artist and track in the URL path — skip it for
    // track-only candidates.
    if (!result.found && artist) {
      const ovh = await fetchFromLyricsOvh(artist, track);
      if (ovh.found) result = ovh;
    }

    // Final fallback: Genius (web scrape). Wider coverage than the JSON APIs.
    if (!result.found) {
      const gen = await fetchFromGenius(artist, track);
      if (gen.found) result = gen;
    }
  }

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
  // Handle AI_STATUS and ALIGN_RESULT from offscreen document
  if (sender.url && sender.url.includes("offscreen.html")) {
    if (message.type === "AI_STATUS") {
      currentAIStatus = { status: message.status, detail: message.detail || null };
      // Re-broadcast so the popup receives it
      chrome.runtime.sendMessage(message).catch(() => {});
    } else if (message.type === "ALIGN_RESULT") {
      handleAlignResult(message);
    }
    return;
  }

  console.log("[SW] received message:", message.type, "from:", sender.url || "unknown");

  switch (message.type) {
    case "START_CAPTURE":
      if (message.mode) currentMode = message.mode;
      console.log("[SW] START_CAPTURE mode:", currentMode, "tabId:", message.tabId);
      handleStartCapture(message.tabId, message.aiModel).then((result) => {
        // Broadcast capture state so popup AND side panel both reflect it.
        if (result && result.success) {
          chrome.runtime.sendMessage({ type: "CAPTURE_STATE", isActive: true }).catch(() => {});
        }
        sendResponse(result);
      });
      return true; // async response

    case "STOP_CAPTURE":
      console.log("[SW] STOP_CAPTURE received, forwarding to offscreen");
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
      chrome.runtime.sendMessage({ type: "SET_MODE", value: message.value });
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
          serverUrl: "ws://localhost:9876",
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
        console.log("Tab navigated away, stopping capture:", changeInfo.url);
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

async function handleStartCapture(tabId, aiModel) {
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
    console.log("[SW] tab URL:", tab.url);

    await ensureOffscreenDocument();
    console.log("[SW] offscreen document ready");

    // Push current settings to the offscreen document (it can't access chrome.storage)
    const settings = await chrome.storage.local.get({
      serverUrl: "ws://localhost:9876",
      apiKey: "",
    });

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });
    console.log("[SW] got stream ID:", streamId);

    // Send stream ID along with current mode so it's applied after capture starts
    capturedTabId = tabId;
    capturedTabUrl = tab.url;

    console.log("[SW] sending STREAM_READY, mode:", currentMode, "aiModel:", aiModel);
    chrome.runtime.sendMessage({
      type: "STREAM_READY",
      streamId: streamId,
      mode: currentMode,
      aiModel: aiModel,
      serverUrl: settings.serverUrl,
      apiKey: settings.apiKey,
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
      reasons: ["USER_MEDIA"],
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
