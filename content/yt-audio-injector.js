// Karafilt read-ahead capture — PHASE 0 PROBE (MAIN world, document_start).
//
// PURPOSE: this build does NOT capture or forward any audio. It only inspects
// YouTube's own media network requests and logs, to the page console, whether
// the audio stream is delivered as interceptable GET WebM/Opus byte-ranges (the
// shape our read-ahead feature needs) — or as POST/UMP/SABR (multiplexed,
// non-interceptable) or DRM/encrypted (must be skipped).
//
// It wraps window.fetch + XMLHttpRequest exactly like the existing caption
// injector (content/yt-captions-injector.js) — clone-and-read so playback is
// never affected. Nothing here decodes audio or talks to the extension yet.
//
// Local research only; gated behind a localStorage flag so it stays silent
// unless explicitly enabled. To enable: on a youtube.com tab run
//   localStorage.kflProbe = '1'
// then reload. To stop: delete localStorage.kflProbe (or just unload the branch).

(() => {
  if (window.__kflYtAudioProbe) return;
  window.__kflYtAudioProbe = true;

  let ENABLED = false;
  try { ENABLED = localStorage.getItem("kflProbe") === "1"; } catch {}

  const TAG = "[KFL-Probe]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  if (!ENABLED) {
    // One quiet hint so it's discoverable, then stay out of the way.
    try {
      console.log(
        `${TAG} idle. To probe YouTube audio delivery, run  localStorage.kflProbe='1'  then reload.`,
      );
    } catch {}
    return;
  }

  log("active (MAIN world) — watching googlevideo media requests…");

  // Audio itags YouTube serves (Opus / AAC / Vorbis). mime=audio is authoritative
  // either way; this is a secondary signal.
  const AUDIO_ITAGS = new Set([
    139, 140, 141, 171, 172, 249, 250, 251, 256, 258, 327, 328, 338, 774,
  ]);

  // Container sniff has run for these itags already (only deep-sniff the first
  // segment per itag to keep overhead negligible).
  const sniffed = new Set();

  function isMediaUrl(url) {
    return typeof url === "string" &&
      url.includes("googlevideo.com") && url.includes("videoplayback");
  }

  function parseInfo(url, method) {
    let u;
    try { u = new URL(url, location.origin); } catch { return null; }
    const q = u.searchParams;
    const mime = decodeURIComponent(q.get("mime") || "");
    const itag = parseInt(q.get("itag") || "0", 10);
    const isAudio = mime.startsWith("audio/") || AUDIO_ITAGS.has(itag);
    return {
      method,
      mime,
      itag,
      isAudio,
      range: q.get("range") || "(header)",
      clen: q.get("clen") || "?",
      ump: q.has("ump") || q.has("sabr") || q.get("sabr") === "1",
    };
  }

  function sniffContainer(buf) {
    const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096));
    // EBML / WebM magic
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      return { container: "WebM/Matroska", codecHint: "Opus/Vorbis" };
    }
    // MP4: 'ftyp' / 'styp' at bytes 4..8
    const fourcc = String.fromCharCode(b[4] || 0, b[5] || 0, b[6] || 0, b[7] || 0);
    if (fourcc === "ftyp" || fourcc === "styp") {
      return { container: "MP4/ISO-BMFF", codecHint: "AAC" };
    }
    return { container: "unknown/other (maybe UMP)", codecHint: "?" };
  }

  function sniffEncrypted(buf) {
    // Rough scan of the first few KB for common encryption fourccs (MP4) — a
    // hint, not authoritative. WebM ContentEncryption isn't reliably sniffable
    // this cheaply; treat absence as "likely clear".
    const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096));
    const s = String.fromCharCode.apply(null, b);
    return /pssh|senc|cenc|enca|encv|tenc/.test(s);
  }

  function report(info, buf) {
    if (!info || !info.isAudio) return;
    if (info.method === "POST" || info.ump) {
      warn(
        `AUDIO via ${info.method}${info.ump ? " (ump/sabr)" : ""} itag=${info.itag} ` +
        `mime="${info.mime}" → multiplexed/obfuscated delivery; NOT interceptable as ranges.`,
      );
      return;
    }
    const base =
      `AUDIO GET itag=${info.itag} mime="${info.mime}" range=${info.range} clen=${info.clen}`;
    if (buf && !sniffed.has(info.itag)) {
      sniffed.add(info.itag);
      const c = sniffContainer(buf);
      const enc = sniffEncrypted(buf);
      log(
        `${base}\n        → ${c.container} (${c.codecHint}), ` +
        `${enc ? "ENCRYPTED/DRM ✗ (would skip)" : "clear ✓"}, first-segment ${buf.byteLength}B`,
      );
      if (c.container.startsWith("WebM") && !enc) {
        log("        ✓✓ interceptable GET WebM/Opus — read-ahead looks FEASIBLE for this video");
      }
    } else {
      log(`${base} (${buf ? buf.byteLength + "B" : "size via header"})`);
    }
  }

  // ── fetch interceptor ──────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = (init && init.method) || (input && input.method) || "GET";
    const response = await origFetch.apply(this, arguments);
    try {
      if (isMediaUrl(url)) {
        const info = parseInfo(url, String(method).toUpperCase());
        if (info && info.isAudio) {
          if (info.method === "POST" || info.ump || sniffed.has(info.itag)) {
            report(info, null);
          } else {
            response.clone().arrayBuffer()
              .then((buf) => report(info, buf))
              .catch(() => report(info, null));
          }
        }
      }
    } catch {
      // never break fetch
    }
    return response;
  };

  // ── XHR interceptor ────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__kflUrl = url;
    this.__kflMethod = method;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      if (isMediaUrl(this.__kflUrl)) {
        this.addEventListener("load", () => {
          try {
            const info = parseInfo(this.__kflUrl, String(this.__kflMethod || "GET").toUpperCase());
            if (!info || !info.isAudio) return;
            const buf =
              this.response instanceof ArrayBuffer ? this.response : null;
            report(info, info.method === "POST" || info.ump ? null : buf);
          } catch {}
        });
      }
    } catch {}
    return origSend.apply(this, arguments);
  };
})();
