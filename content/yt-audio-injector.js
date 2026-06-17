// Karafilt read-ahead capture — PHASE 0 PROBE (MAIN world, document_start).
//
// PURPOSE: inspect-only. Captures/forwards NO audio. It checks two possible
// interception points for YouTube's look-ahead audio and logs what it finds:
//   (1) network: GET WebM/Opus byte-ranges (works only on the legacy path);
//   (2) MSE: SourceBuffer.appendBuffer — the segments YouTube hands the browser
//       AFTER de-obfuscating SABR/UMP. This is the robust point: it's the clean,
//       already-demuxed audio buffered ahead of the playhead.
//
// Modern YouTube uses SABR (POST/UMP), so (1) usually stays silent and (2) is
// the path that matters. If (2) also stays silent, YouTube is doing MSE in a
// Worker (harder — would need a worker hook).
//
// Local research only. Gated behind a localStorage flag:
//   localStorage.kflProbe = '1'   (then reload). Filter the console by
//   "KFL-Probe" to cut YouTube/ad-blocker noise.

(() => {
  if (window.__kflYtAudioProbe) return;
  window.__kflYtAudioProbe = true;

  let ENABLED = false;
  try { ENABLED = localStorage.getItem("kflProbe") === "1"; } catch {}

  const TAG = "[KFL-Probe]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  if (!ENABLED) {
    try {
      console.log(`${TAG} idle. To probe, run  localStorage.kflProbe='1'  then reload.`);
    } catch {}
    return;
  }

  log("active (MAIN world). Watching network ranges + MSE appendBuffer. Filter console by 'KFL-Probe'.");

  const AUDIO_ITAGS = new Set([139, 140, 141, 171, 172, 249, 250, 251, 256, 258, 327, 328, 338, 774]);
  const seen = new Set(); // dedupe one-shot signals

  function once(key) {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }

  function sniffContainer(u8) {
    if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
      return { container: "WebM/Matroska", codecHint: "Opus/Vorbis" };
    }
    const fourcc = String.fromCharCode(u8[4] || 0, u8[5] || 0, u8[6] || 0, u8[7] || 0);
    if (fourcc === "ftyp" || fourcc === "styp" || fourcc === "sidx" || fourcc === "moof") {
      return { container: "MP4/ISO-BMFF", codecHint: "AAC" };
    }
    return { container: "unknown/other", codecHint: "?" };
  }

  function sniffEncrypted(u8) {
    let s = "";
    for (let i = 0; i < Math.min(u8.length, 2048); i++) s += String.fromCharCode(u8[i]);
    return /pssh|senc|cenc|enca|encv|tenc/.test(s);
  }

  function toU8(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  // ── (2) MSE: the path that matters under SABR ──────────────────────────
  // Tag each SourceBuffer audio/video at creation (mime tells us), then watch
  // what gets appended. Appends happen ahead of the playhead = look-ahead.
  let mseHooked = false;
  try {
    if (typeof MediaSource !== "undefined" && MediaSource.prototype.addSourceBuffer) {
      const origAdd = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime) {
        const sb = origAdd.apply(this, arguments);
        try {
          sb.__kflAudio = /audio/i.test(String(mime || ""));
          log(`MSE SourceBuffer created: "${mime}" ${sb.__kflAudio ? "← AUDIO" : "(video)"}`);
        } catch {}
        return sb;
      };

      const origAppend = SourceBuffer.prototype.appendBuffer;
      const counts = new WeakMap();
      SourceBuffer.prototype.appendBuffer = function (data) {
        try {
          if (this.__kflAudio) {
            const u8 = toU8(data);
            const n = (counts.get(this) || 0) + 1;
            counts.set(this, n);
            if (u8 && once("mse-audio-first")) {
              const c = sniffContainer(u8);
              const enc = sniffEncrypted(u8);
              log(
                `MSE AUDIO append #${n}: ${u8.byteLength}B → ${c.container} (${c.codecHint}), ` +
                (enc ? "ENCRYPTED/DRM ✗" : "clear ✓"),
              );
              if ((c.container.startsWith("WebM") || c.container.startsWith("MP4")) && !enc) {
                log("  ✓✓ FEASIBLE: clean de-UMP'd audio segments are reachable via SourceBuffer — read-ahead can work here");
              } else if (enc) {
                warn("  ✗ audio segments look encrypted (DRM) — read-ahead would skip this content");
              }
            } else if (u8 && n % 25 === 0) {
              log(`MSE AUDIO append #${n} (${u8.byteLength}B) — still flowing ahead of playhead`);
            }
          }
        } catch {}
        return origAppend.apply(this, arguments);
      };
      mseHooked = true;
    }
  } catch {}
  if (!mseHooked) warn("MediaSource not hookable in this context (MSE may run in a Worker).");

  // ── (1) network: legacy GET ranges + SABR/POST detection (informational) ─
  function isMediaUrl(url) {
    return typeof url === "string" && url.includes("googlevideo.com") && url.includes("videoplayback");
  }
  function noteNetwork(url, method) {
    let u; try { u = new URL(url, location.origin); } catch { return; }
    const q = u.searchParams;
    const mime = decodeURIComponent(q.get("mime") || "");
    const itag = parseInt(q.get("itag") || "0", 10);
    const isAudio = mime.startsWith("audio/") || AUDIO_ITAGS.has(itag);
    const M = String(method || "GET").toUpperCase();
    if (M === "POST" || q.has("sabr") || q.has("ump")) {
      if (once("net-sabr")) warn("network: videoplayback via POST/SABR/UMP → not interceptable as ranges (expected on modern YT; using MSE path instead).");
      return;
    }
    if (isAudio && once("net-audio-get-" + itag)) {
      log(`network: legacy GET audio itag=${itag} mime="${mime}" range=${q.get("range") || "(header)"} — interceptable directly too.`);
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || (input && input.method) || "GET";
      if (isMediaUrl(url)) noteNetwork(url, method);
    } catch {}
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { if (isMediaUrl(url)) noteNetwork(url, method); } catch {}
    return origOpen.apply(this, arguments);
  };
})();
