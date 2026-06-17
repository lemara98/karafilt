// Karafilt read-ahead capture — PHASE 1 PROBE (MAIN world, document_start).
//
// Builds on the Phase 0 finding that YouTube hands the browser clean WebM/Opus
// audio via MSE SourceBuffer.appendBuffer (ahead of the playhead) even under
// SABR. This phase PROVES we can turn those segments into real PCM:
//   MSE appendBuffer(audio) → rolling WebM stream → EBML demux → Opus packets
//   → WebCodecs AudioDecoder → Float32 PCM. It then logs decode correctness
//   (sample rate, channels, RMS, and the LEAD = content-time − video.currentTime,
//   which must be > 0 to confirm we're decoding audio the playhead hasn't reached).
//
// Still inspect-only: it decodes and measures, but forwards/plays NOTHING.
// Local research; gated behind localStorage.kflProbe='1' (then reload). Filter
// the console by "KFL-Probe".

(() => {
  if (window.__kflYtAudioProbe) return;
  window.__kflYtAudioProbe = true;

  let PROBE = false, LIVE = false;
  try { PROBE = localStorage.getItem("kflProbe") === "1"; } catch {}
  try { LIVE = localStorage.getItem("kflLookahead") === "1"; } catch {}
  const TAG = "[KFL-Probe]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  if (!PROBE && !LIVE) {
    try { console.log(`${TAG} idle. Probe: localStorage.kflProbe='1'. Live: localStorage.kflLookahead='1'. Then reload.`); } catch {}
    return;
  }
  log(`active (${LIVE ? "LIVE: decode + post PCM" : "Phase 1: demux + decode"}). Filter console by 'KFL-Probe'.`);

  // Coalesced PCM posting → isolated world (only in LIVE mode).
  const POST_BLOCK_SECONDS = 1.0;
  let blkParts = [], blkFrames = 0, blkStart = null, blkChannels = 2, blkRate = 48000;
  function flushBlock() {
    if (!blkParts.length) return;
    const total = blkFrames * blkChannels;
    const out = new Float32Array(total);
    let o = 0;
    for (const p of blkParts) { out.set(p, o); o += p.length; }
    try {
      window.postMessage(
        { kfl: "KFL_LOOKAHEAD_PCM", contentTime: blkStart, sampleRate: blkRate, channels: blkChannels, pcm: out.buffer },
        "*", [out.buffer],
      );
    } catch (e) { if (once("post-throw")) warn("postMessage failed:", e && e.message); }
    blkParts = []; blkFrames = 0; blkStart = null;
  }
  function postPcm(ad, contentTime) {
    blkRate = ad.sampleRate; blkChannels = ad.numberOfChannels;
    const n = ad.numberOfFrames;
    const inter = new Float32Array(n * blkChannels);
    try { ad.copyTo(inter, { planeIndex: 0, format: "f32" }); }
    catch { try { ad.copyTo(inter, { planeIndex: 0 }); } catch { return; } }
    if (blkStart === null) blkStart = contentTime;
    blkParts.push(inter); blkFrames += n;
    if (blkFrames >= POST_BLOCK_SECONDS * blkRate) flushBlock();
  }

  const seen = new Set();
  const once = (k) => (seen.has(k) ? false : (seen.add(k), true));
  const videoEl = () => document.querySelector("video");

  // ── EBML var-int readers ───────────────────────────────────────────────
  // readId keeps the length-marker bits (so IDs match the standard hex values).
  // readSize strips them and flags the all-ones "unknown size" form.
  function vintLen(first) {
    let mask = 0x80, len = 1;
    while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
    return len > 8 ? 0 : len;
  }
  function readId(buf, pos) {
    if (pos >= buf.length) return null;
    const len = vintLen(buf[pos]);
    if (!len || pos + len > buf.length) return null;
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
    return { value: v, len };
  }
  function readSize(buf, pos) {
    if (pos >= buf.length) return null;
    const len = vintLen(buf[pos]);
    if (!len || pos + len > buf.length) return null;
    const marker = 1 << (8 - len);
    let v = buf[pos] & (marker - 1);
    let allOnes = v === marker - 1;
    for (let i = 1; i < len; i++) {
      v = v * 256 + buf[pos + i];
      if (buf[pos + i] !== 0xff) allOnes = false;
    }
    return { value: v, len, unknown: allOnes };
  }
  function readUint(u8) { let v = 0; for (let i = 0; i < u8.length; i++) v = v * 256 + u8[i]; return v; }

  // Element IDs we care about. Master elements are "descended into" (we read
  // their header then keep walking their children inline); everything else is a
  // leaf we either use or skip by its size.
  const MASTERS = new Set([
    0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0xe1,
    0x1f43b675, 0xa0,
  ]);
  const ID_TIMESTAMPSCALE = 0x2ad7b1;
  const ID_TRACKNUMBER = 0xd7;
  const ID_CODECID = 0x86;
  const ID_CODECPRIVATE = 0x63a2;
  const ID_TIMESTAMP = 0xe7;     // cluster base timestamp
  const ID_SIMPLEBLOCK = 0xa3;
  const ID_BLOCK = 0xa1;

  // ── Demux + decode state ───────────────────────────────────────────────
  let buf = new Uint8Array(0);
  let pos = 0;
  let timestampScale = 1e6;       // ns per tick (WebM default)
  let audioTrack = null;
  let opusHead = null;
  let clusterTs = 0;
  let decoder = null;
  let decodedSeconds = 0;
  let decodedChunks = 0;

  // Persistent, time-sorted store of demuxed Opus packets (NOT a consumed queue).
  // Keeping them lets us decode from any position on a seek — including seeks INTO
  // already-buffered content, where YouTube never re-appends (so a consumed queue
  // would starve until the playhead reached the buffer end tens of seconds later).
  // We still decode only a small window AHEAD of the playhead, via a cursor.
  let packets = [];            // [{tsUs, frame}], sorted by tsUs, deduped
  let playedThru = -1;         // tsUs decoded up to (advances with the playhead)
  const DECODE_WINDOW_S = 30;  // decode this far ahead → lead for big (15s) pod batches
  const MAX_DECODE_PER_TICK_S = 6; // cap per 150ms tick so the fill doesn't burst/jank
  const HISTORY_S = 90;        // keep this much behind the playhead for back-seeks
  let pumpTimer = null;
  let needResync = false;
  let seekWired = false;

  function addPacket(tsUs, frame) {
    const n = packets.length;
    if (n === 0 || tsUs > packets[n - 1].tsUs) { packets.push({ tsUs, frame }); return; }
    // out-of-order (e.g. a re-fetch after a back-seek): binary insert, dedup ~1ms
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (packets[m].tsUs < tsUs) lo = m + 1; else hi = m; }
    if (lo < n && Math.abs(packets[lo].tsUs - tsUs) < 1000) return;
    packets.splice(lo, 0, { tsUs, frame });
  }
  function firstIndexAfter(tsUs) {   // first i with packets[i].tsUs > tsUs
    let lo = 0, hi = packets.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (packets[m].tsUs <= tsUs) lo = m + 1; else hi = m; }
    return lo;
  }

  // On seek, re-aim the decode cursor at the new position and start a fresh
  // decoder (clean timestamps). KEEP `packets` so buffered regions replay
  // instantly; needResync re-aligns the demuxer for any future appends.
  function onSeek() {
    const v = document.querySelector("video");
    const newPos = v ? v.currentTime : 0;
    playedThru = (newPos - 0.2) * 1e6;
    needResync = true;
    clusterTs = 0;
    if (decoder) { try { decoder.close(); } catch {} decoder = null; }
    log(`seek → cursor=${newPos.toFixed(2)}s, stored=${packets.length} pkts, opusHead=${opusHead ? "kept" : "MISSING"}`);
  }

  function pump() {
    const v = document.querySelector("video");
    if (v && !seekWired) { seekWired = true; v.addEventListener("seeked", onSeek); }
    if (!decoder) ensureDecoder();
    if (!decoder || !v) return;
    // NOTE: we DO decode while paused — packets are kept in the store, so the
    // pipeline can fill ahead during the pause-to-buffer load (and resume is
    // instant). `now` is frozen while paused, so the window stays bounded.
    const now = v.currentTime;
    // Never decode far behind the playhead (after a forward jump / long stall).
    if (playedThru < (now - 1) * 1e6) playedThru = (now - 1) * 1e6;
    const horizonTs = (now + DECODE_WINDOW_S) * 1e6;
    // Spread the (now larger) window over a few ticks so the initial fill never
    // decodes ~1500 packets at once and janks the page.
    const tickHorizonTs = Math.min(horizonTs, playedThru + MAX_DECODE_PER_TICK_S * 1e6);
    let i = firstIndexAfter(playedThru), guard = 0;
    for (; i < packets.length && guard < 4000; i++, guard++) {
      const p = packets[i];
      if (p.tsUs > tickHorizonTs) break;   // ahead of this tick's slice — next tick
      try { decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: p.tsUs, data: p.frame })); }
      catch (e) { if (once("decode-throw")) warn("decode threw:", e && e.message); }
      playedThru = p.tsUs;
    }
    // Bound memory: drop history older than HISTORY_S behind the playhead.
    const cutoff = (now - HISTORY_S) * 1e6;
    if (packets.length > 200 && packets[0].tsUs < cutoff) {
      let d = 0; while (d < packets.length && packets[d].tsUs < cutoff) d++;
      if (d > 50) packets.splice(0, d);
    }
  }

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  function ensureDecoder() {
    if (decoder || !opusHead) return;
    if (typeof AudioDecoder === "undefined") { warn("WebCodecs AudioDecoder unavailable"); return; }
    const channels = opusHead.length > 9 ? opusHead[9] : 2;
    try {
      decoder = new AudioDecoder({
        output: onAudioData,
        error: (e) => warn("decoder error:", e && e.message),
      });
      decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: channels, description: opusHead });
      log(`decoder configured: opus, ${channels}ch, 48kHz (OpusHead ${opusHead.length}B)`);
    } catch (e) {
      warn("decoder.configure failed:", e && e.message);
      decoder = null;
    }
  }

  function onAudioData(ad) {
    try {
      const rate = ad.sampleRate, ch = ad.numberOfChannels, n = ad.numberOfFrames;
      const contentTime = ad.timestamp / 1e6;
      decodedSeconds += n / rate;
      decodedChunks++;
      if (LIVE) postPcm(ad, contentTime);
      if (PROBE && (decodedChunks <= 3 || decodedChunks % 50 === 0)) {
        let rms = 0;
        try {
          const f = new Float32Array(n);
          ad.copyTo(f, { planeIndex: 0, format: "f32-planar" });
          for (let i = 0; i < n; i++) rms += f[i] * f[i];
          rms = Math.sqrt(rms / n);
        } catch {}
        const v = videoEl();
        const cur = v ? v.currentTime : NaN;
        const lead = isFinite(cur) ? (contentTime - cur).toFixed(2) : "?";
        log(
          `decoded #${decodedChunks}: t=${contentTime.toFixed(2)}s ${ch}ch ${rate}Hz ` +
          `rms=${rms.toFixed(4)} | total=${decodedSeconds.toFixed(1)}s decoded | ` +
          `LEAD over playhead=${lead}s (currentTime=${isFinite(cur) ? cur.toFixed(2) : "?"})`,
        );
        if (once("first-decode") && rms > 0) {
          log("  ✓✓ PHASE 1 PASS: look-ahead WebM/Opus decodes to valid PCM ahead of the playhead.");
        }
      }
    } catch (e) {
      warn("onAudioData error:", e && e.message);
    } finally {
      ad.close();
    }
  }

  function handleSimpleBlock(data) {
    // [vint track][int16 BE rel timecode][flags][frame...]
    const tn = readSize(data, 0); // track number is a vint (strip marker)
    if (!tn) return;
    let p = tn.len;
    if (p + 3 > data.length) return;
    const rel = (data[p] << 8) | data[p + 1]; // signed int16 BE
    const relTime = rel >= 0x8000 ? rel - 0x10000 : rel;
    p += 2;
    p += 1; // flags byte (ignore lacing — Opus blocks are single-frame on YT)
    const frame = data.subarray(p);
    if (audioTrack != null && tn.value !== audioTrack) return; // not the audio track
    if (audioTrack == null) audioTrack = tn.value;
    if (frame.length === 0) return;
    const tsUs = Math.round(((clusterTs + relTime) * timestampScale) / 1000); // ns→µs
    // Store (sorted, deduped); the windowed pump() decodes from the cursor.
    addPacket(tsUs, frame.slice());
  }

  // Scan for the next EBML header (init segment) or Cluster start — used to
  // re-align the parser after a seek, regardless of where the byte-stream was cut.
  function findResyncPoint(b, from) {
    for (let i = Math.max(0, from); i + 4 <= b.length; i++) {
      if (b[i] === 0x1a && b[i + 1] === 0x45 && b[i + 2] === 0xdf && b[i + 3] === 0xa3) return i; // EBML
      if (b[i] === 0x1f && b[i + 1] === 0x43 && b[i + 2] === 0xb6 && b[i + 3] === 0x75) return i; // Cluster
    }
    return -1;
  }

  // Flat EBML walk over the rolling buffer from `pos`. Descends into masters,
  // uses/skip leaves, and stops at the first incomplete element (resumes on the
  // next append). Commits `pos` only past fully-consumed elements.
  function parse() {
    if (needResync) {
      const at = findResyncPoint(buf, pos);
      if (at < 0) {                               // boundary hasn't arrived yet
        if (buf.length - pos > 1 << 16) { buf = buf.slice(buf.length - 4); pos = 0; } // bound memory, keep tail
        return;
      }
      pos = at;
      needResync = false;
    }
    while (pos < buf.length) {
      const id = readId(buf, pos);
      if (!id) break;
      const sz = readSize(buf, pos + id.len);
      if (!sz) break;
      const headerLen = id.len + sz.len;
      const dataStart = pos + headerLen;

      if (MASTERS.has(id.value)) {
        if (id.value === 0x1f43b675) clusterTs = 0; // new cluster
        pos = dataStart; // descend (don't skip children)
        continue;
      }
      // leaf: need full data present
      if (sz.unknown) { pos = dataStart; continue; } // unknown-size non-master: skip header, keep walking
      if (dataStart + sz.value > buf.length) break;   // incomplete leaf — wait for more
      const data = buf.subarray(dataStart, dataStart + sz.value);
      switch (id.value) {
        case ID_TIMESTAMPSCALE: timestampScale = readUint(data) || timestampScale; break;
        case ID_CODECID: break; // could verify "A_OPUS"
        case ID_CODECPRIVATE: if (!opusHead) { opusHead = data.slice(); ensureDecoder(); } break;
        case ID_TRACKNUMBER: if (audioTrack == null) audioTrack = readUint(data); break;
        case ID_TIMESTAMP: clusterTs = readUint(data); break;
        case ID_SIMPLEBLOCK:
        case ID_BLOCK: handleSimpleBlock(data); break;
        default: break;
      }
      pos = dataStart + sz.value;
    }
    // Trim consumed prefix to bound memory.
    if (pos > 1 << 20) { buf = buf.slice(pos); pos = 0; }
  }

  function feedAudio(u8) {
    if (!u8 || u8.length === 0) return;
    buf = concat(buf, u8);
    try { parse(); } catch (e) { if (once("parse-throw")) warn("parse error:", e && e.message); }
    pump();
    // Keep decoding as the playhead advances, even without new appends.
    if (!pumpTimer) pumpTimer = setInterval(pump, 150);
  }

  // ── MSE hooks ──────────────────────────────────────────────────────────
  function toU8(d) {
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    return null;
  }
  let mseHooked = false;
  try {
    if (typeof MediaSource !== "undefined" && MediaSource.prototype.addSourceBuffer) {
      const origAdd = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime) {
        const sb = origAdd.apply(this, arguments);
        try {
          sb.__kflAudio = /audio/i.test(String(mime || "")) && /opus|webm/i.test(String(mime || ""));
          if (sb.__kflAudio) log(`audio SourceBuffer: "${mime}"`);
        } catch {}
        return sb;
      };
      const origAppend = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function (data) {
        try { if (this.__kflAudio) { const u8 = toU8(data); if (u8) feedAudio(u8.slice()); } } catch {}
        return origAppend.apply(this, arguments);
      };
      mseHooked = true;
    }
  } catch {}
  if (!mseHooked) warn("MediaSource not hookable here (MSE may run in a Worker).");

  // ── light network SABR note (informational) ────────────────────────────
  const isMedia = (u) => typeof u === "string" && u.includes("googlevideo.com") && u.includes("videoplayback");
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const m = (init && init.method) || "GET";
      if (isMedia(url) && (String(m).toUpperCase() === "POST" || /[?&](sabr|ump)=/.test(url)) && once("sabr"))
        warn("network is SABR/POST (using the MSE path).");
    } catch {}
    return origFetch.apply(this, arguments);
  };
})();
