// Runs in YouTube's MAIN world (not the extension's isolated world).
// Reads ytInitialPlayerResponse to find caption track URLs, fetches them
// (same-origin, no CORS issues), and posts parsed cues back to the
// extension's isolated content script via window.postMessage.

(() => {
  if (window.__kflYtInjected) return;
  window.__kflYtInjected = true;

  const MSG_REQUEST = "KFL_GET_YT_CAPTIONS";
  const MSG_RESULT = "KFL_YT_CAPTIONS_RESULT";

  // In-memory cache of captions captured via YouTube's own fetch calls.
  // Keyed by the URL path (minus signing params), so different videos don't
  // collide. Populated by the fetch/XHR interceptors below.
  const capturedCaptions = new Map();

  function cacheKeyFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const v = u.searchParams.get("v") || "";
      const lang = u.searchParams.get("lang") || "";
      const tlang = u.searchParams.get("tlang") || "";
      return `${v}|${lang}|${tlang}`;
    } catch (e) {
      return url;
    }
  }

  function tryParseCaptionsBody(url, body) {
    if (!body) return null;
    try {
      // Try JSON first (json3 format)
      const trimmed = body.trim();
      if (trimmed.startsWith("{")) {
        const data = JSON.parse(trimmed);
        const lines = parseJson3(data);
        if (lines.length > 0) return lines;
      }
      // Try XML (srv3 or srv1)
      if (trimmed.startsWith("<")) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(trimmed, "application/xml");
        // srv3: <p t="..."> elements
        let lines = [];
        doc.querySelectorAll("p").forEach((p) => {
          const t = parseInt(p.getAttribute("t") || "0", 10);
          const text = (p.textContent || "").replace(/\s+/g, " ").trim();
          if (text) lines.push({ time: t / 1000, text });
        });
        if (lines.length > 0) return lines;
        // srv1: <text start="..."> elements
        lines = [];
        doc.querySelectorAll("text").forEach((el) => {
          const start = parseFloat(el.getAttribute("start") || "0");
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (text) lines.push({ time: start, text });
        });
        if (lines.length > 0) return lines;
      }
      // Try VTT
      if (trimmed.startsWith("WEBVTT") || trimmed.includes("-->")) {
        return parseVTTLocal(trimmed);
      }
    } catch (e) {
      console.log("[KFL-Injector] failed to parse intercepted response:", e.message);
    }
    return null;
  }

  function parseVTTLocal(text) {
    const lines = [];
    const blocks = text.split(/\r?\n\r?\n+/);
    for (const block of blocks) {
      const m = block.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\.(\d{3})\s*-->/);
      if (!m) continue;
      const h1 = m[3] ? parseInt(m[1], 10) : 0;
      const mn1 = m[3] ? parseInt(m[2], 10) : parseInt(m[1], 10);
      const s1 = m[3] ? parseInt(m[3], 10) : parseInt(m[2], 10);
      const ms1 = parseInt(m[4], 10);
      const time = h1 * 3600 + mn1 * 60 + s1 + ms1 / 1000;
      const textIdx = block.indexOf("\n");
      const cueText = textIdx >= 0
        ? block.slice(textIdx + 1).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
        : "";
      if (cueText) lines.push({ time, text: cueText });
    }
    return lines;
  }

  function isTimedTextUrl(url) {
    return typeof url === "string" && url.includes("/api/timedtext");
  }

  // Install fetch interceptor — captures responses to YouTube's own timedtext requests
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await originalFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (isTimedTextUrl(url) && response.ok) {
        const clone = response.clone();
        clone.text().then((body) => {
          const lines = tryParseCaptionsBody(url, body);
          if (lines && lines.length > 0) {
            const key = cacheKeyFromUrl(url);
            capturedCaptions.set(key, lines);
            console.log(
              `[KFL-Injector] Intercepted ${lines.length} caption lines from YouTube's fetch (${key})`
            );
          }
        }).catch(() => {});
      }
    } catch (e) {
      // Don't break fetch
    }
    return response;
  };

  // Install XHR interceptor — some YouTube code paths use XHR instead of fetch
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__kflUrl = url;
    return origXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (isTimedTextUrl(this.__kflUrl)) {
      this.addEventListener("load", () => {
        try {
          if (this.status >= 200 && this.status < 300) {
            const lines = tryParseCaptionsBody(this.__kflUrl, this.responseText);
            if (lines && lines.length > 0) {
              const key = cacheKeyFromUrl(this.__kflUrl);
              capturedCaptions.set(key, lines);
              console.log(
                `[KFL-Injector] Intercepted ${lines.length} caption lines from YouTube's XHR (${key})`
              );
            }
          }
        } catch (e) {}
      });
    }
    return origXhrSend.apply(this, arguments);
  };

  function getCapturedForCurrentVideo() {
    try {
      const videoId = new URL(location.href).searchParams.get("v");
      if (!videoId) return null;
      // Find any cached entry matching this video ID
      for (const [key, lines] of capturedCaptions.entries()) {
        if (key.startsWith(videoId + "|") && lines && lines.length > 0) {
          return { lines, key };
        }
      }
    } catch (e) {}
    return null;
  }

  function log(...args) {
    console.log("[KFL-Injector]", ...args);
  }

  function getCaptionTracks() {
    const pr = window.ytInitialPlayerResponse;
    if (!pr) {
      log("ytInitialPlayerResponse is not available yet");
      return [];
    }
    if (!pr.captions) {
      log("ytInitialPlayerResponse has no .captions", Object.keys(pr));
      return [];
    }
    const renderer = pr.captions.playerCaptionsTracklistRenderer;
    if (!renderer) {
      log("No playerCaptionsTracklistRenderer", Object.keys(pr.captions));
      return [];
    }
    const tracks = renderer.captionTracks;
    if (!Array.isArray(tracks)) {
      log("captionTracks is not an array", typeof tracks);
      return [];
    }
    log(`Found ${tracks.length} caption track(s):`,
      tracks.map((t) => ({
        language: t.languageCode,
        name: t.name && t.name.simpleText,
        kind: t.kind || "(human)",
      })));
    return tracks;
  }

  async function waitForTracks(maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const tracks = getCaptionTracks();
      if (tracks.length > 0) return tracks;
      await new Promise((r) => setTimeout(r, 150));
    }
    return [];
  }

  function withFmt(baseUrl, fmt) {
    // Strip any existing fmt= param to avoid conflict, then append the requested one
    let cleanedUrl = baseUrl.replace(/([?&])fmt=[^&]*/, "$1").replace(/[?&]$/, "");
    const sep = cleanedUrl.includes("?") ? "&" : "?";
    return cleanedUrl + sep + "fmt=" + fmt;
  }

  function parseJson3(data) {
    const events = (data && data.events) || [];
    const lines = [];
    for (const evt of events) {
      if (!evt.segs || typeof evt.tStartMs !== "number") continue;
      const text = evt.segs
        .map((s) => (s && typeof s.utf8 === "string" ? s.utf8 : ""))
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      lines.push({ time: evt.tStartMs / 1000, text });
    }
    return lines;
  }

  // VTT parser for WebVTT format:
  //   00:01.234 --> 00:03.500
  //   caption text
  function parseVTT(text) {
    const lines = [];
    const blocks = text.split(/\r?\n\r?\n+/);
    for (const block of blocks) {
      const m = block.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\.(\d{3})\s*-->\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\.(\d{3})/);
      if (!m) continue;
      // Handle both HH:MM:SS.xxx and MM:SS.xxx
      const h1 = m[3] ? parseInt(m[1], 10) : 0;
      const mn1 = m[3] ? parseInt(m[2], 10) : parseInt(m[1], 10);
      const s1 = m[3] ? parseInt(m[3], 10) : parseInt(m[2], 10);
      const ms1 = parseInt(m[4], 10);
      const time = h1 * 3600 + mn1 * 60 + s1 + ms1 / 1000;
      const textIdx = block.indexOf("\n");
      const cueText = textIdx >= 0
        ? block.slice(textIdx + 1).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
        : "";
      if (!cueText) continue;
      lines.push({ time, text: cueText });
    }
    return lines;
  }

  async function fetchCaptionsAsText(baseUrl, fmt, parser) {
    const url = fmt ? withFmt(baseUrl, fmt) : baseUrl.replace(/([?&])fmt=[^&]*/, "$1").replace(/[?&]$/, "");
    log(`Fetching captions (${fmt || "no-fmt"}):`, url);
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        log(`${fmt || "no-fmt"} fetch failed with status`, res.status);
        return null;
      }
      const body = await res.text();
      if (!body || body.trim().length === 0) {
        log(`${fmt || "no-fmt"} returned empty body`);
        return null;
      }
      const lines = parser(body);
      log(`${fmt || "no-fmt"} parsed, lines:`, lines.length);
      return lines.length > 0 ? lines : null;
    } catch (e) {
      log(`${fmt || "no-fmt"} fetch threw:`, e.message);
      return null;
    }
  }

  // Parser for srv3 XML
  function parseSrv3(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    const pElements = doc.querySelectorAll("p");
    const lines = [];
    pElements.forEach((p) => {
      const t = parseInt(p.getAttribute("t") || "0", 10);
      let text = p.textContent || "";
      text = text.replace(/\s+/g, " ").trim();
      if (!text) return;
      lines.push({ time: t / 1000, text });
    });
    return lines;
  }

  // Parser for srv1 XML (older format with <text start="..." dur="...">)
  function parseSrv1(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    const textElements = doc.querySelectorAll("text");
    const lines = [];
    textElements.forEach((el) => {
      const start = parseFloat(el.getAttribute("start") || "0");
      let text = el.textContent || "";
      text = text.replace(/\s+/g, " ").trim();
      if (!text) return;
      lines.push({ time: start, text });
    });
    return lines;
  }

  async function fetchCaptions(baseUrl) {
    // Try multiple formats in order of preference
    const attempts = [
      { fmt: "json3", parser: (body) => {
        try {
          return parseJson3(JSON.parse(body));
        } catch (e) { return []; }
      }},
      { fmt: "srv3", parser: parseSrv3 },
      { fmt: "vtt", parser: parseVTT },
      { fmt: "srv1", parser: parseSrv1 },
      { fmt: null, parser: parseSrv1 }, // no fmt = default XML, try srv1 parser
    ];
    for (const attempt of attempts) {
      const lines = await fetchCaptionsAsText(baseUrl, attempt.fmt, attempt.parser);
      if (lines && lines.length > 0) return lines;
    }
    return null;
  }

  async function handleRequest() {
    log("Caption request received");

    // First check if we intercepted YouTube's own caption fetch — most reliable
    const captured = getCapturedForCurrentVideo();
    if (captured) {
      log(`Using intercepted captions (${captured.lines.length} lines, key=${captured.key})`);
      window.postMessage(
        {
          type: MSG_RESULT,
          lines: captured.lines,
          intercepted: true,
        },
        "*"
      );
      return;
    }

    // Otherwise, wait briefly and recheck — YouTube may fetch captions shortly after our request
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const late = getCapturedForCurrentVideo();
      if (late) {
        log(`Using intercepted captions (${late.lines.length} lines, late capture)`);
        window.postMessage(
          { type: MSG_RESULT, lines: late.lines, intercepted: true },
          "*"
        );
        return;
      }
    }

    // Fall back to actively reading ytInitialPlayerResponse and fetching directly
    const tracks = await waitForTracks(3000);
    if (tracks.length === 0) {
      log("No caption tracks found after 3s wait");
      window.postMessage(
        { type: MSG_RESULT, lines: null, reason: "no_tracks" },
        "*"
      );
      return;
    }

    // Prefer human-authored (kind omitted) over auto-generated (kind === "asr")
    const sorted = [...tracks].sort((a, b) => {
      const aAuto = a.kind === "asr" ? 1 : 0;
      const bAuto = b.kind === "asr" ? 1 : 0;
      return aAuto - bAuto;
    });

    for (const track of sorted) {
      if (!track.baseUrl) continue;
      try {
        const lines = await fetchCaptions(track.baseUrl);
        if (lines && lines.length > 0) {
          log(`Track ${track.languageCode} succeeded with ${lines.length} lines`);
          window.postMessage(
            {
              type: MSG_RESULT,
              lines,
              language: track.languageCode || null,
              auto: track.kind === "asr",
            },
            "*"
          );
          return;
        }
        log(`Track ${track.languageCode} returned no lines, trying next`);
      } catch (e) {
        log("Track fetch threw, trying next:", e.message);
      }
    }

    window.postMessage(
      { type: MSG_RESULT, lines: null, reason: "fetch_failed" },
      "*"
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== MSG_REQUEST) return;
    handleRequest();
  });
})();
