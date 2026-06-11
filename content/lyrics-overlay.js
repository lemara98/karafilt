// Karafilt — Lyrics Data Provider (Content Script)
// Runs on every page. Extracts song metadata + lyrics from:
//   1. LRCLib (via service worker)
//   2. YouTube captions (via MAIN-world injector)
//   3. YouTube description (DOM scrape)
// Publishes lyrics state and playback time to the side panel via chrome.runtime.sendMessage.

(() => {
  // Prevent double-injection
  if (window.__karaokeFilterLyricsLoaded) return;
  window.__karaokeFilterLyricsLoaded = true;

  // Set to true for verbose console logging during development. This script
  // runs in every page's console, so it must stay quiet in production.
  const KF_DEBUG = false;
  const dbg = (...args) => { if (KF_DEBUG) console.log(...args); };

  // ─── Feature flags ──────────────────────────────────────────────────────
  // YouTube caption extraction is disabled: it requires a MAIN-world script
  // that intercepts YouTube's own timedtext fetches, which sits in a gray area
  // for Chrome Web Store policy. LRCLib (+ Lyrics.ovh + Genius fallbacks)
  // covers our use cases.
  const ENABLE_YT_CAPTION_EXTRACTION = false;
  // ────────────────────────────────────────────────────────────────────────

  // --- State ---
  let parsedLines = [];
  let plainLyrics = null;
  // Other matches LRCLib returned. Each entry: {trackName, artistName,
  // syncedLyrics, plainLyrics, source}. Forwarded to the side panel so the
  // user can switch to one if the auto-pick is wrong.
  let alternatives = [];
  // Metadata of the currently-selected match (the one whose lyrics fill
  // parsedLines/plainLyrics). Forwarded to the side panel so it can render
  // it at the top of the alternatives list with a "current" marker, and so
  // the user can switch back to it after picking an alternative. Shape:
  // {trackName, artistName, source, syncedLyrics?, plainLyrics?, syncedLines?}.
  let primary = null;
  let mediaElement = null;
  let playbackTickerId = null;
  let lastFetchedKey = null;
  let loadGeneration = 0;
  let showLyrics = true;
  let currentStatus = "";

  const PLAYBACK_TICK_MS = 200;

  // --- Shared song-matching core ---
  // cleanTitle / parseTitle / candidate generation now live in
  // shared/song-match.js (loaded before this script via manifest
  // content_scripts) so the request side and the service-worker match side
  // can never drift apart. extractYouTubeMetadata() below stays here because it
  // needs the DOM; its result is fed to SM.parseTitle as a hint.
  const SM = (typeof globalThis !== "undefined" && globalThis.KarafiltSongMatch) || self.KarafiltSongMatch;
  const cleanTitle = SM.cleanTitle;

  // Walk a script's text content from a marker keyword and return the JSON
  // object that follows the next `{`. Brace-counts so nested objects don't
  // confuse it; respects strings so braces inside values are skipped. Used to
  // pull `ytInitialPlayerResponse` out of YouTube's inline scripts without
  // relying on brittle regex.
  function extractScriptJson(text, marker) {
    const idx = text.indexOf(marker);
    if (idx === -1) return null;
    const startBrace = text.indexOf("{", idx + marker.length);
    if (startBrace === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startBrace; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === "\"") { inString = !inString; continue; }
      if (inString) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(startBrace, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  // Pull canonical {artist, track} from YouTube's embedded metadata. Source
  // priority:
  //   1. schema.org MusicVideoObject in <script type="application/ld+json"> —
  //      authoritative when present (verified music videos).
  //   2. ytInitialPlayerResponse JSON in inline scripts — has clean
  //      videoDetails.title + videoDetails.author for every video.
  //   3. DOM channel selector — last resort if the page hasn't injected the
  //      JSON yet (rare, but content scripts run at document_idle so usually OK).
  // Auto-generated artist channels show "<Artist> - Topic"; we strip the
  // "- Topic" suffix to get the canonical artist.
  let ytMetaCache = { key: null, value: null };
  function extractYouTubeMetadata() {
    if (!isYouTube()) return null;
    const cacheKey = location.href;
    if (ytMetaCache.key === cacheKey) return ytMetaCache.value;

    let result = null;

    // 1. schema.org
    try {
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of ldScripts) {
        let data;
        try { data = JSON.parse(s.textContent || ""); } catch { continue; }
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const t = item && item["@type"];
          if (t === "MusicVideoObject" || t === "MusicRecording") {
            const track = (item.name || "").toString().trim();
            let artist = "";
            if (item.byArtist) {
              artist = (item.byArtist.name || item.byArtist || "").toString().trim();
            }
            if (track) {
              result = { track, artist, source: "schema" };
              break;
            }
          }
        }
        if (result) break;
      }
    } catch {}

    // 2. ytInitialPlayerResponse
    if (!result) {
      try {
        for (const s of document.querySelectorAll("script")) {
          const text = s.textContent;
          if (!text || !text.includes("ytInitialPlayerResponse")) continue;
          const data = extractScriptJson(text, "ytInitialPlayerResponse");
          if (!data || !data.videoDetails) continue;
          const track = (data.videoDetails.title || "").toString().trim();
          let artist = (data.videoDetails.author || "").toString().trim();
          artist = artist.replace(/\s*-\s*Topic\s*$/i, "").trim();
          if (track) {
            result = { track, artist, source: "ytInitialPlayerResponse" };
            break;
          }
        }
      } catch {}
    }

    // 3. DOM channel selector
    if (!result) {
      const selectors = [
        "ytd-video-owner-renderer ytd-channel-name a",
        "ytd-channel-name a.yt-formatted-string",
        "#owner-name a",
        "#channel-name a",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        let artist = (el.textContent || "").trim();
        artist = artist.replace(/\s*-\s*Topic\s*$/i, "").trim();
        if (artist) {
          result = { track: cleanTitle(document.title), artist, source: "dom" };
          break;
        }
      }
    }

    ytMetaCache = { key: cacheKey, value: result };
    return result;
  }

  // Build the metadata hint from YouTube's embedded data (DOM) and hand the
  // raw title to the shared parser, which produces the ordered candidate
  // {artist, track} pairs. All pure parsing lives in shared/song-match.js.
  function buildSongHint() {
    const meta = extractYouTubeMetadata();
    if (!meta) return {};
    return {
      metaTrack: meta.track || "",
      metaArtist: meta.artist || "",
      author: meta.artist || "",
    };
  }

  function parseTitle(rawTitle) {
    return SM.parseTitle(rawTitle, buildSongHint());
  }

  // --- LRC parser ---
  function parseLRC(lrc) {
    const lines = [];
    const lineRe = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
    for (const rawLine of lrc.split(/\r?\n/)) {
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
      for (const t of timestamps) lines.push({ time: t, text });
    }
    lines.sort((a, b) => a.time - b.time);
    return lines;
  }

  // --- Media detection ---
  function findMedia() {
    const allMedia = Array.from(document.querySelectorAll("video, audio"));
    if (allMedia.length === 0) return null;
    const playing = allMedia.find((m) => !m.paused && m.currentTime > 0);
    return playing || allMedia[0];
  }

  // --- Extension liveness guard ---
  let contextInvalidated = false;
  function isExtensionValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // --- LRCLib + fallbacks via service worker ---
  // Two phases to keep total lookup time low:
  //   1. Try LRCLib for *every* candidate (fast — ~400ms each).
  //   2. Only if phase 1 misses, do ONE call with full fallback chain
  //      (Lyrics.ovh + Genius). This caps the worst case at ~9s instead of
  //      the ~30s we had when Genius ran for every candidate.
  function sendFetchLyrics(c, opts) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "FETCH_LYRICS",
            artist: c.artist,
            track: c.track,
            album: c.album || "",
            durationSec: (opts && opts.durationSec) || 0,
            lrclibOnly: !!(opts && opts.lrclibOnly),
            forceRefresh: !!(opts && opts.forceRefresh),
            skipLrclib: !!(opts && opts.skipLrclib),
          },
          (res) => {
            if (chrome.runtime.lastError) {
              contextInvalidated = true;
              resolve({ found: false, invalidated: true });
              return;
            }
            resolve(res || { found: false });
          }
        );
      } catch (e) {
        contextInvalidated = true;
        resolve({ found: false, invalidated: true });
      }
    });
  }

  // Pick the candidate most likely to give Genius/Lyrics.ovh a clean query:
  // first one with a non-empty artist that doesn't contain commas. Falls back
  // to track-only if no clean artist exists, then to candidates[0] as last resort.
  function pickFallbackCandidate(candidates) {
    return (
      candidates.find((c) => c.artist && !/[,&]/.test(c.artist)) ||
      candidates.find((c) => !c.artist) ||
      candidates[0]
    );
  }

  async function fetchLyrics(title, opts) {
    if (contextInvalidated || !isExtensionValid()) {
      contextInvalidated = true;
      return { found: false, invalidated: true };
    }
    const forceRefresh = !!(opts && opts.forceRefresh);
    const onPartial = (opts && opts.onPartial) || null;
    // Lean fan-out (top 3 candidates; candidate #0 from the metadata is almost
    // always right). Fewer requests = faster, especially when LRCLib is slow.
    const candidates = parseTitle(title).slice(0, 3);
    // The duration of the playing media disambiguates same-titled recordings.
    // 0 = unknown (live stream / not yet loaded) — the SW then ignores it.
    const media = findMedia();
    const durationSec = media && isFinite(media.duration) && media.duration > 0 ? media.duration : 0;

    const isSynced = (r) => !!(r && r.syncedLyrics);
    const effScore = (r) =>
      r.matchScore != null ? r.matchScore : isSynced(r) ? -5 : 50;

    // Phase 1: fire the LRCLib-only lookups in parallel, but DON'T wait for the
    // slowest. Resolve the moment any synced result arrives, and surface the
    // first plain result immediately via onPartial so something shows while the
    // rest (and a possible synced upgrade) are still in flight.
    const phase1 = await new Promise((resolve) => {
      let settled = 0, done = false, bestPlain = null, shownPlain = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      candidates.forEach((c) => {
        sendFetchLyrics(c, { lrclibOnly: true, forceRefresh, durationSec })
          .then((r) => {
            settled++;
            if (done) return;
            if (r && r.invalidated) return finish(r);
            if (r && r.found) {
              if (isSynced(r)) {
                if (onPartial) onPartial(r);   // show synced right away
                return finish(r);              // synced = best; stop waiting
              }
              if (!bestPlain || effScore(r) < effScore(bestPlain)) bestPlain = r;
              if (!shownPlain && onPartial) { shownPlain = true; onPartial(r); }
            }
            if (settled === candidates.length) finish(bestPlain || { found: false });
          })
          .catch(() => {
            settled++;
            if (settled === candidates.length) finish(bestPlain || { found: false });
          });
      });
      if (candidates.length === 0) finish({ found: false });
    });
    if (phase1 && phase1.invalidated) return phase1;
    if (phase1 && phase1.found) return phase1;

    // Phase 2: full chain (LRCLib already known to miss, so this is really
    // Lyrics.ovh + Genius) on the cleanest candidate. skipLrclib avoids a
    // redundant LRCLib round-trip — phase 1 already tried it for every candidate.
    const fallback = pickFallbackCandidate(candidates);
    if (fallback) {
      const result = await sendFetchLyrics(fallback, { lrclibOnly: false, forceRefresh, skipLrclib: true, durationSec });
      if (result.invalidated) return result;
      if (result.found) return result;
    }
    return { found: false };
  }

  // --- YouTube ---
  function isYouTube() {
    return /(^|\.)youtube\.com$/.test(location.hostname);
  }

  async function extractYouTubeCaptions() {
    if (!ENABLE_YT_CAPTION_EXTRACTION) return null;
    if (!isYouTube()) return null;
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", listener);
        clearTimeout(timer);
        resolve(val);
      };
      const listener = (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.type !== "KFL_YT_CAPTIONS_RESULT") return;
        finish(event.data.lines || null);
      };
      const timer = setTimeout(() => finish(null), 5000);
      window.addEventListener("message", listener);
      window.postMessage({ type: "KFL_GET_YT_CAPTIONS" }, "*");
    });
  }

  // --- DOM-based caption scraping (last resort) ---
  // When YouTube's timedtext API refuses to serve the data but the player
  // is rendering captions on screen, watch those rendered captions and build
  // up the lyric timeline progressively as the song plays.
  const YT_CAPTION_SELECTORS = [
    ".ytp-caption-segment",
    ".captions-text",
    ".caption-visual-line",
  ];
  let domScraperActive = false;
  let domCapturedLines = [];
  let domLastText = "";
  let domScraperIntervalId = null;

  function findYouTubeCaptionText() {
    for (const sel of YT_CAPTION_SELECTORS) {
      const elements = document.querySelectorAll(sel);
      if (elements.length === 0) continue;
      // Concatenate text from all segments (captions can span multiple elements)
      const text = Array.from(elements)
        .map((el) => el.innerText || el.textContent || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text;
    }
    return "";
  }

  function startDOMCaptionScraper() {
    if (!isYouTube()) return;
    if (domScraperActive) return;
    domScraperActive = true;
    domCapturedLines = [];
    domLastText = "";

    const video = findMedia();
    if (!video) {
      domScraperActive = false;
      return;
    }

    domScraperIntervalId = setInterval(() => {
      const video = mediaElement && document.contains(mediaElement) ? mediaElement : findMedia();
      if (!video) return;
      const text = findYouTubeCaptionText();
      if (!text || text === domLastText) return;
      domLastText = text;

      // Avoid duplicates (same text near the same time)
      const newTime = Math.max(0, video.currentTime - 0.3); // back-nudge: caption appears ~0.3s after audio
      const last = domCapturedLines[domCapturedLines.length - 1];
      if (last && last.text === text) return;

      domCapturedLines.push({ time: newTime, text });

      // Update state: treat captured DOM captions as synced lines
      parsedLines = [...domCapturedLines];
      plainLyrics = null;
      currentStatus = `YouTube on-screen captions (${domCapturedLines.length} captured)`;
      publishState();
    }, 250);
  }

  function stopDOMCaptionScraper() {
    if (domScraperIntervalId != null) {
      clearInterval(domScraperIntervalId);
      domScraperIntervalId = null;
    }
    domScraperActive = false;
  }

  // --- State publishing ---
  function safeSendMessage(msg) {
    if (!isExtensionValid()) {
      contextInvalidated = true;
      return;
    }
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      contextInvalidated = true;
    }
  }

  function publishState() {
    safeSendMessage({
      type: "LYRICS_STATE",
      state: {
        title: document.title,
        cleanedTitle: cleanTitle(document.title),
        parsedLines,
        plainLyrics,
        alternatives,
        primary,
        status: currentStatus,
        hasMedia: !!findMedia(),
      },
    });
  }

  function setStatus(s) {
    currentStatus = s || "";
    publishState();
  }

  // Publish playback time every PLAYBACK_TICK_MS for sync highlighting
  let publishPlaybackCount = 0;
  let publishPlaybackSkipReasons = { noMedia: 0, contextDead: 0, ok: 0 };
  function publishPlaybackTime() {
    const media = mediaElement && document.contains(mediaElement) ? mediaElement : findMedia();
    mediaElement = media;
    if (!media) {
      publishPlaybackSkipReasons.noMedia++;
      if (publishPlaybackCount++ < 5 || publishPlaybackCount % 50 === 0) {
        dbg("[KFL-CS] publishPlaybackTime: no media element found", publishPlaybackSkipReasons);
      }
      return;
    }
    if (!isExtensionValid()) {
      publishPlaybackSkipReasons.contextDead++;
      return;
    }
    publishPlaybackSkipReasons.ok++;
    if (publishPlaybackCount < 5 || publishPlaybackCount % 50 === 0) {
      dbg(`[KFL-CS] publishPlaybackTime ok t=${media.currentTime.toFixed(2)} paused=${media.paused}`, publishPlaybackSkipReasons);
    }
    publishPlaybackCount++;
    safeSendMessage({
      type: "PLAYBACK_TIME",
      time: media.currentTime,
      duration: isFinite(media.duration) ? media.duration : 0,
      paused: media.paused,
    });
  }

  function startPlaybackTicker() {
    if (playbackTickerId != null) {
      dbg("[KFL-CS] startPlaybackTicker called but already running");
      return;
    }
    dbg("[KFL-CS] startPlaybackTicker — interval starting at", PLAYBACK_TICK_MS, "ms");
    playbackTickerId = setInterval(publishPlaybackTime, PLAYBACK_TICK_MS);
  }

  function stopPlaybackTicker() {
    if (playbackTickerId != null) {
      dbg("[KFL-CS] stopPlaybackTicker — interval stopping");
      clearInterval(playbackTickerId);
      playbackTickerId = null;
    }
  }

  // --- Main flow ---
  // forceRefresh=true bypasses both the local lastFetchedKey short-circuit and
  // the SW's lyricsCache. Used by the side-panel's manual Refresh button.
  async function loadLyricsForCurrentSong(opts) {
    const forceRefresh = !!(opts && opts.forceRefresh);
    const title = document.title;
    if (!title) return;
    if (!findMedia()) return;
    const normalizedKey = cleanTitle(title);
    if (!normalizedKey) return;
    if (!forceRefresh && normalizedKey === lastFetchedKey) return;
    // Only the FOREGROUND tab fetches. Background tabs (other YouTube tabs,
    // auto-advancing radio playlists, etc.) would each fire their own lyric
    // lookups and flood the shared lrclib request queue — starving the tab you
    // are actually viewing (observed: lrclib waits growing to 40s+). The
    // visibilitychange listener re-fetches when this tab is brought to front.
    // lastFetchedKey is left unset here so a hidden tab re-fetches once visible.
    if (document.visibilityState !== "visible") return;
    lastFetchedKey = normalizedKey;

    const myGen = ++loadGeneration;
    const isStale = () => myGen !== loadGeneration;

    const hadPriorLyrics = parsedLines.length > 0 || plainLyrics;
    if (!hadPriorLyrics) {
      parsedLines = [];
      plainLyrics = null;
      alternatives = [];
      primary = null;
      setStatus("Looking up lyrics...");
    }

    const commitSynced = (lines, statusText, alts, meta) => {
      if (isStale()) return;
      parsedLines = lines;
      plainLyrics = null;
      alternatives = alts || [];
      primary = meta || null;
      setStatus(statusText);
    };
    const commitPlain = (text, statusText, alts, meta) => {
      if (isStale()) return;
      if (parsedLines.length > 0) return;
      plainLyrics = text;
      parsedLines = [];
      alternatives = alts || [];
      primary = meta || null;
      setStatus(statusText);
    };

    // Commit an LRCLib / lyrics.ovh / Genius result (synced preferred). Called
    // BOTH progressively as candidates resolve (via onPartial) and for the final
    // result, so the first plain shows instantly then upgrades to synced.
    const commitLrclib = (r) => {
      if (isStale() || !r || !r.found) return false;
      const meta = {
        trackName: r.trackName,
        artistName: r.artistName,
        source: r.source,
        syncedLyrics: r.syncedLyrics || null,
        plainLyrics: r.plainLyrics || null,
      };
      if (r.syncedLyrics) {
        const lines = parseLRC(r.syncedLyrics);
        if (lines.length > 0) {
          const label = r.source === "lrclib" ? "LRCLib (synced)" : `${r.source || "synced"} (synced)`;
          commitSynced(lines, label, r.alternatives, meta);
          return true;
        }
      }
      if (r.plainLyrics) {
        const label = r.source === "genius" ? "Genius (unsynced)"
          : r.source === "lyrics.ovh" ? "Lyrics.ovh (unsynced)"
          : "LRCLib (unsynced)";
        commitPlain(r.plainLyrics, label, r.alternatives, meta);
        return true;
      }
      return false;
    };

    // 1. LRCLib (+ lyrics.ovh / Genius fallback in the SW), streamed in as the
    //    candidates resolve.
    stopDOMCaptionScraper(); // drop any prior on-screen-caption scraper
    const lrclibResult = await fetchLyrics(title, { forceRefresh, onPartial: commitLrclib });
    if (isStale()) return;
    if (lrclibResult.invalidated) {
      setStatus("Extension was reloaded — please refresh this tab");
      return;
    }
    if (commitLrclib(lrclibResult)) return;   // got real text lyrics — done

    // 2. LAST resort only (no text lyrics from any source): scrape the player's
    //    on-screen captions. Gated behind the text sources so it can never
    //    override real lyrics with YouTube's auto-captions.
    if (isYouTube()) {
      const onScreen = findYouTubeCaptionText();
      if (onScreen) {
        startDOMCaptionScraper();
        setStatus("YouTube on-screen captions (capturing...)");
        return;
      }
    }

    if (!hadPriorLyrics && !domScraperActive) setStatus("No lyrics found for this song");
  }

  // --- Watch for SPA URL changes (YouTube navigates without reloading the page) ---
  function getPathKey() {
    try {
      const u = new URL(location.href);
      if (u.hostname.endsWith("youtube.com")) {
        // On YouTube, the ?v= param identifies the video
        return u.pathname + "?v=" + (u.searchParams.get("v") || "");
      }
      return u.pathname;
    } catch (e) {
      return location.pathname;
    }
  }

  // True only on a YouTube /watch?v=… URL. Other YouTube pages (search,
  // home, channel, feed) are explicit no-ops for the lyric lookup.
  function isYouTubeWatchPage() {
    if (!isYouTube()) return true; // non-YouTube sites: trust media detection
    try {
      const u = new URL(location.href);
      return u.pathname === "/watch" && !!u.searchParams.get("v");
    } catch {
      return false;
    }
  }

  // ── Song-change detection ──────────────────────────────────────────────
  // Three independent signals can announce a new song: URL change (SPA
  // navigation), <title> change, and a media element firing `loadstart`
  // (new src). Each routes through maybeRefresh(), which debounces ~400ms
  // so signals from one navigation coalesce, then performRefresh() checks
  // a composite (URL + cleaned title) songKey. A fetch fires whenever the
  // key actually moves — so even if URL fires first with a stale title,
  // the title MutationObserver triggers a second pass with the correct title
  // a moment later. loadGeneration in loadLyricsForCurrentSong prevents a
  // late-arriving stale fetch from clobbering a newer one.
  function getSongKey() {
    return getPathKey() + "|" + cleanTitle(document.title);
  }

  let lastSongKey = "";
  let refreshTimer = null;

  function performRefresh(reason) {
    refreshTimer = null;
    const key = getSongKey();
    if (key === lastSongKey) return;
    lastSongKey = key;
    dbg("[KFL-CS] song change via", reason, "→ key=", key);

    parsedLines = [];
    plainLyrics = null;
    alternatives = [];
    primary = null;
    currentLineIndex = -1;
    currentStatus = "Loading...";
    lastFetchedKey = null;
    mediaElement = null;
    stopDOMCaptionScraper();
    safeSendMessage({ type: "LYRICS_RESET" });
    publishState();

    // On YouTube, only trigger a fetch on watch pages. Search/home/channel
    // navigations clear stale state but don't fire a useless lookup.
    if (!isYouTubeWatchPage()) {
      currentStatus = "";
      publishState();
      return;
    }

    // If the new <video> isn't in the DOM yet (YouTube briefly tears it down
    // between videos), wait for it before fetching.
    if (findMedia()) {
      loadLyricsForCurrentSong();
    } else {
      watchForMedia(() => loadLyricsForCurrentSong());
    }
  }

  function maybeRefresh(reason) {
    if (refreshTimer != null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => performRefresh(reason), 400);
  }

  function watchUrlChanges() {
    // Patch history.pushState / replaceState to emit a custom event
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      const ret = origPush.apply(this, arguments);
      window.dispatchEvent(new Event("kfl-locationchange"));
      return ret;
    };
    history.replaceState = function () {
      const ret = origReplace.apply(this, arguments);
      window.dispatchEvent(new Event("kfl-locationchange"));
      return ret;
    };
    window.addEventListener("popstate", () =>
      window.dispatchEvent(new Event("kfl-locationchange"))
    );
    window.addEventListener("kfl-locationchange", () => maybeRefresh("url"));
  }

  // --- Watch for title changes ---
  function watchTitleChanges() {
    const titleEl = document.querySelector("title");
    if (!titleEl) {
      setTimeout(watchTitleChanges, 500);
      return;
    }
    const observer = new MutationObserver(() => maybeRefresh("title"));
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // --- Watch for media element src changes ---
  // Catches the case where YouTube swaps the <video> element between songs:
  // the new element fires `loadstart` once it gets a src. Capturing on the
  // document means we don't have to re-bind every time the element is
  // replaced.
  function watchMediaSourceChanges() {
    document.addEventListener("loadstart", (e) => {
      const t = e.target;
      if (t && (t.tagName === "VIDEO" || t.tagName === "AUDIO")) {
        maybeRefresh("media-loadstart");
      }
    }, true);
  }

  // --- Watch for media element appearing (SPAs) ---
  function watchForMedia(onMediaFound) {
    if (findMedia()) {
      onMediaFound();
      return;
    }
    const observer = new MutationObserver(() => {
      if (findMedia()) {
        observer.disconnect();
        onMediaFound();
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // --- Respond to messages ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "REQUEST_LYRICS_STATE") {
      publishState();
      // Also force a fresh lookup in case title was stable but we hadn't fetched
      if (showLyrics && parsedLines.length === 0 && !plainLyrics) {
        loadLyricsForCurrentSong();
      }
      sendResponse({ ok: true });
    } else if (message.type === "SET_SHOW_LYRICS") {
      showLyrics = !!message.value;
      if (showLyrics) {
        loadLyricsForCurrentSong();
        startPlaybackTicker();
      } else {
        stopPlaybackTicker();
      }
    } else if (message.type === "REFRESH_LYRICS") {
      // Manual refresh from the side panel — wipe local state + cache, retry.
      parsedLines = [];
      plainLyrics = null;
      alternatives = [];
      primary = null;
      currentLineIndex = -1;
      lastFetchedKey = null;
      currentStatus = "Refreshing…";
      publishState();
      loadLyricsForCurrentSong({ forceRefresh: true });
    } else if (message.type === "SYNC_CONTROL") {
      // Popup countdown asks us to pause / play the active media so the
      // capture and the original audio start together at "GO".
      const m = mediaElement && document.contains(mediaElement) ? mediaElement : findMedia();
      if (!m) return;
      mediaElement = m;
      try {
        if (message.action === "pause") {
          m.pause();
        } else if (message.action === "play") {
          // play() returns a Promise that may reject (e.g. autoplay policy).
          // If it does, the user can press play themselves — no error needed.
          const p = m.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
      } catch {
        // Media element may have been torn down by the page — ignore.
      }
    } else if (message.type === "MEDIA_SEEK_RELATIVE") {
      // AI sync: offscreen finished prebuffering and the queued AI audio
      // represents video content from ~L seconds ago. Seek the video back by
      // L so the user sees frames matching the audio they're about to hear.
      // One-shot per AI session; drift may return after the prebuffered
      // chunks play out — toggling AI off/on resets it.
      const m = mediaElement && document.contains(mediaElement) ? mediaElement : findMedia();
      if (!m) return;
      mediaElement = m;
      const delta = Number(message.deltaSeconds);
      if (!isFinite(delta)) return;
      try {
        const newTime = Math.max(0, m.currentTime + delta);
        m.currentTime = newTime;
        dbg(`[KFL-CS] AI sync seek: ${delta.toFixed(2)}s → currentTime=${newTime.toFixed(2)}s`);
      } catch {
        // currentTime is settable only when readyState ≥ 1 — ignore otherwise.
      }
    }
  });

  // --- Init ---
  dbg("[KFL-CS] content script loaded for", location.href);
  if (!isExtensionValid()) {
    dbg("[KFL-CS] extension invalid at load — bailing");
    return;
  }
  try {
    chrome.storage.local.get({ showLyrics: true }, (s) => {
      if (chrome.runtime.lastError) {
        dbg("[KFL-CS] storage error:", chrome.runtime.lastError);
        return;
      }
      showLyrics = s.showLyrics;
      dbg("[KFL-CS] init: showLyrics =", showLyrics);
      watchUrlChanges();
      watchTitleChanges();
      watchMediaSourceChanges();
      // Re-fetch when this tab is brought to the foreground (fetching is gated
      // to the visible tab — see loadLyricsForCurrentSong).
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && showLyrics) {
          loadLyricsForCurrentSong();
        }
      });
      watchForMedia(() => {
        dbg("[KFL-CS] media found via watchForMedia, showLyrics=", showLyrics);
        if (showLyrics) {
          maybeRefresh("init");
          startPlaybackTicker();
        }
      });
    });
  } catch (e) {
    dbg("[KFL-CS] init threw:", e);
  }
})();
