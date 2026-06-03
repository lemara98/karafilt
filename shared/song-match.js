// Karafilt — Song matching core (shared, pure, DOM-free)
//
// One source of truth for: cleaning a messy page/video title, generating
// {artist, track} candidates, building LRCLib API requests, and scoring the
// rows LRCLib returns. Loaded three ways:
//   - content script  : listed in manifest content_scripts BEFORE lyrics-overlay.js
//   - service worker  : importScripts("shared/song-match.js")
//   - Node test harness: require()/import (module.exports)
// Keep this file free of DOM / chrome.* so it stays unit-testable in Node.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  // Always expose on the global for classic-script consumers.
  if (root) root.KarafiltSongMatch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ── Transliteration / folding ──────────────────────────────────────────
  // NFD strips most Latin diacritics, but some characters don't decompose
  // (đ, ø, ł, æ, ß…) and Cyrillic needs an explicit map. We fold to ASCII so
  // a Cyrillic / diacritic title still matches a Latin LRCLib row.
  const SPECIAL_LATIN = {
    "đ": "d", "ð": "d", "ł": "l", "ø": "o", "æ": "ae", "œ": "oe",
    "ß": "ss", "þ": "th", "ı": "i", "ŋ": "n", "ħ": "h", "ĸ": "k",
  };
  const CYRILLIC = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "ђ": "dj", "е": "e",
    "ж": "z", "з": "z", "и": "i", "ј": "j", "к": "k", "л": "l", "љ": "lj",
    "м": "m", "н": "n", "њ": "nj", "о": "o", "п": "p", "р": "r", "с": "s",
    "т": "t", "ћ": "c", "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "c",
    "џ": "dz", "ш": "s", "ѕ": "dz", "і": "i", "ы": "y", "э": "e", "ю": "yu",
    "я": "ya", "й": "j", "ё": "e", "щ": "sc", "ъ": "", "ь": "",
  };

  function translit(s) {
    if (!s) return "";
    let out = "";
    for (const ch of s.toLowerCase()) {
      if (Object.prototype.hasOwnProperty.call(SPECIAL_LATIN, ch)) out += SPECIAL_LATIN[ch];
      else if (Object.prototype.hasOwnProperty.call(CYRILLIC, ch)) out += CYRILLIC[ch];
      else out += ch;
    }
    return out;
  }

  // Lowercased, diacritic/script-folded to ASCII letters.
  function asciiFold(s) {
    return translit(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  // Metadata noise words removed before fuzzy comparison. Symmetric (applied to
  // both the requested string and the LRCLib row) so it only ever helps.
  const NOISE_WORDS =
    /\b(hd|hq|uhd|4k|8k|2160p|1440p|1080p?|720p|audio|video|lyric|lyrics|official|oficial|officiel|mv|live|vivo|directo|remaster|remastered|remix|rmx|stereo|mono|version|visualizer|visualiser|performance)\b/g;

  function normalizeForMatch(s) {
    return asciiFold(s || "")
      .replace(NOISE_WORDS, " ")
      .replace(/[^a-z0-9]+/g, " ")
      // drop a trailing "feat …" / "featuring …" clause some rows embed
      .replace(/\s(feat|ft|featuring|prod)\s.*$/, "")
      .trim();
  }

  // ── Levenshtein (two rolling rows) ─────────────────────────────────────
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let v0 = new Array(b.length + 1);
    let v1 = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) v0[j] = j;
    for (let i = 0; i < a.length; i++) {
      v1[0] = i + 1;
      for (let j = 0; j < b.length; j++) {
        const cost = a[i] === b[j] ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      const tmp = v0; v0 = v1; v1 = tmp;
    }
    return v0[b.length];
  }

  function trackDistance(a, b) {
    return levenshtein(normalizeForMatch(a), normalizeForMatch(b));
  }

  // Track names match if normalized-equal or within 15% edit distance (min 2).
  function fuzzyTrackMatch(cand, req) {
    const a = normalizeForMatch(cand);
    const b = normalizeForMatch(req);
    if (!a || !b) return false;
    if (a === b) return true;
    const tol = Math.max(2, Math.floor(Math.max(a.length, b.length) * 0.15));
    return levenshtein(a, b) <= tol;
  }

  // Artist match (a bit looser, plus substring so "BTS" ~ "BTS (방탄소년단)").
  function artistMatchStrong(rowArtist, wantArtist) {
    const a = normalizeForMatch(rowArtist);
    const b = normalizeForMatch(wantArtist);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return true;
    const tol = Math.max(2, Math.floor(Math.max(a.length, b.length) * 0.2));
    return levenshtein(a, b) <= tol;
  }

  // ── Title cleaning ─────────────────────────────────────────────────────
  const SUFFIX_PATTERNS = [
    // parenthesized / bracketed "official …" in several languages
    /\s*\(official[^)]*\)/i, /\s*\[official[^\]]*\]/i,
    /\s*\(officiel[^)]*\)/i,
    /\s*\(\s*v[ií]deo\s+oficial\s*\)/i, /\s*\[\s*v[ií]deo\s+oficial\s*\]/i,
    /\s*\(\s*oficial\s*\)/i, /\s*\[\s*oficial\s*\]/i,
    /\s*\(\s*en\s+vivo[^)]*\)/i, /\s*\(\s*en\s+directo[^)]*\)/i,
    /\s*\(lyrics?[^)]*\)/i, /\s*\[lyrics?[^\]]*\]/i,
    /\s*\(audio\)/i, /\s*\[audio\]/i,
    /\s*\(\s*video\s*\)/i, /\s*\[\s*video\s*\]/i,
    /\s*\(\s*visuali[sz]er\s*\)/i, /\s*\[\s*visuali[sz]er\s*\]/i,
    // quality tags ANYWHERE inside parens/brackets (not just literal "(4k)")
    /\s*\([^)]*\b(?:4k|8k|uhd|full\s*hd|hd|hq|2160p|1440p|1080p?|720p)\b[^)]*\)/i,
    /\s*\[[^\]]*\b(?:4k|8k|uhd|full\s*hd|hd|hq|2160p|1440p|1080p?|720p)\b[^\]]*\]/i,
    // album-format markers
    /\s*\((?:cd|lp|ep|album|single)\)/i, /\s*\[(?:cd|lp|ep|album|single)\]/i,
    // remaster ANYWHERE inside parens/brackets
    /\s*\([^)]*\bremaster(?:ed)?\b[^)]*\)/i, /\s*\[[^\]]*\bremaster(?:ed)?\b[^\]]*\]/i,
    // remix / rmx inside parens/brackets
    /\s*\([^)]*\b(?:remix|rmx)\b[^)]*\)/i, /\s*\[[^\]]*\b(?:remix|rmx)\b[^\]]*\]/i,
    // live inside parens/brackets
    /\s*\(live[^)]*\)/i, /\s*\[live[^\]]*\]/i,
    // featured artists in parens/brackets (incl. spelled-out + "with")
    /\s*\((?:feat|ft|featuring|with|w)\.?\s[^)]*\)/i,
    /\s*\[(?:feat|ft|featuring|with|w)\.?\s[^\]]*\]/i,
    // trailing bare "feat./ft./featuring …" (NOT bare "with" — too ambiguous)
    /\s*\b(?:feat|ft|featuring)\.?\s+.+$/i,
    // year parens/brackets
    /\s*\(\d{4}[^)]*\)/, /\s*\[\d{4}[^\]]*\]/,
    // trailing bare quality / format words
    /\s*[\(\[]?\b(?:full\s*hd|hd|uhd|4k|8k|hq|m\/?v|av)\b[\)\]]?\s*$/i,
    /\s*[\(\[]?\b(?:official\s+(?:music\s+)?video|official\s+audio|lyric\s+video|lyrics?|audio|visuali[sz]er)\b[\)\]]?\s*$/i,
    // trailing platform suffixes
    /\s*\|\s*spotify\s*$/i, /\s*-\s*youtube\s*$/i, /\s*-\s*soundcloud\s*$/i,
    // trailing ", First Last, First Last" YouTube featured-artist convention
    /(\s*,\s*[\p{Lu}]\p{Ll}+(?:\s+[\p{Lu}]\p{Ll}+){0,2}){2,}\s*$/u,
  ];

  function cleanTitle(s) {
    let out = (s || "").toString();
    // leading "(3) " notification-count badge YouTube adds to the tab title
    out = out.replace(/^\s*\(\d+\)\s+/, "");
    // strip emoji / pictographs anywhere (common in lyric-channel titles)
    out = out.replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu, "");
    // apply suffix patterns repeatedly until stable so stacked tags all go
    // (e.g. "(Official Video) [4K Remastered]" → "" in two passes)
    let prev;
    let guard = 0;
    do {
      prev = out;
      for (const re of SUFFIX_PATTERNS) out = out.replace(re, "");
      out = out.trim();
    } while (out !== prev && ++guard < 8);
    return out.replace(/\s{2,}/g, " ").trim();
  }

  // When metadata/author gives an artist and the title repeats it as a prefix
  // ("nipplepeople SUTRA" with author "Nipplepeople") strip the duplicate.
  function stripArtistFromTrack(artist, track) {
    if (!artist || !track) return track;
    const ft = asciiFold(track);
    const fa = asciiFold(artist);
    if (!fa) return track;
    if (ft.startsWith(fa + " ") || ft.startsWith(fa + "-") || ft.startsWith(fa + ":")) {
      // slice by token count rather than raw length (fold can change length)
      const rest = track.slice(artist.length).replace(/^[\s\-:]+/, "").trim();
      if (rest) return rest;
    }
    return track;
  }

  // ── Candidate generation ───────────────────────────────────────────────
  function looksLikeName(s) {
    return /[A-Za-zÀ-ɏЀ-ӿ]/.test(s) && s.trim().length >= 2;
  }

  // Yield [{full artist, track}, {split piece, track}…]. Conservative on " x ".
  function expandArtists(artistStr, trackStr) {
    const out = [{ artist: artistStr, track: trackStr }];
    if (!artistStr) return out;
    let parts = null;
    if (/[,&]|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b/i.test(artistStr)) {
      parts = artistStr.split(/\s*(?:,|&|\bfeaturing\b|\bfeat\.?\b|\bft\.?\b)\s*/i);
    } else if (/\s+x\s+/i.test(artistStr)) {
      const xs = artistStr.split(/\s+x\s+/i);
      if (xs.length === 2 && xs.every(looksLikeName)) parts = xs;
    }
    if (parts) {
      for (const a of parts.map((s) => s.trim()).filter(Boolean)) {
        if (a.toLowerCase() !== artistStr.toLowerCase()) out.push({ artist: a, track: trackStr });
      }
    }
    return out;
  }

  function dedupCandidates(list) {
    const seen = new Set();
    const out = [];
    for (const c of list) {
      if (!c || !c.track) continue;
      const track = c.track.trim();
      if (!track) continue;
      const artist = (c.artist || "").trim();
      const album = (c.album || "").trim();
      const key = artist.toLowerCase() + "|" + track.toLowerCase() + "|" + album.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = { artist, track };
      if (album) entry.album = album;
      out.push(entry);
    }
    return out;
  }

  function metadataMatchesTitle(metaTrack, rawTitle) {
    const a = normalizeForMatch(rawTitle);
    const b = normalizeForMatch(metaTrack);
    if (!a || !b) return false;
    return a.includes(b) || b.includes(a);
  }

  // Trailing dash-segment descriptors we can safely drop ("- Live in Madrid 2011").
  const DESCRIPTOR =
    /\b(live|remaster|remastered|version|acoustic|radio edit|extended|remix|instrumental|karaoke|cover|audio|video|visuali[sz]er|session|unplugged|demo|mono|stereo|edit)\b/i;
  function isDescriptorSeg(s) {
    return DESCRIPTOR.test(s) || /^\(?\d{4}\)?$/.test(s.trim()) || /^in\s+\p{Lu}/u.test(s);
  }

  // Strip a leading parenthetical script gloss off an artist ("BTS (방탄소년단)" → "BTS").
  function cleanArtist(s) {
    return (s || "")
      .replace(/^\s*\(\d+\)\s+/, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
  }

  // Pull a quoted track out of `Artist "Track"` / `Artist 'Track'` titles.
  function extractQuoted(s) {
    // double / smart double quotes first (most reliable)
    let m = s.match(/[“"]([^”"]{2,})[”"]/);
    if (m) return { before: s.slice(0, m.index), inner: m[1] };
    // single / smart single quotes — require surrounding whitespace so we
    // don't trip on apostrophes inside words ("Don't", "Rock 'n' Roll").
    m = s.match(/(?:^|\s)[‘']([^’']{2,}?)[’'](?=\s|$)/);
    if (m && /[A-Za-zÀ-ɏЀ-ӿ　-鿿가-힯]/.test(m[1])) {
      return { before: s.slice(0, m.index), inner: m[1] };
    }
    return null;
  }

  // Prefer an inner English gloss: "神메뉴(God's Menu)" → "God's Menu".
  function preferGloss(inner) {
    const m = inner.match(/\(([A-Za-z][^)]*[A-Za-z'’])\)/);
    if (m) return m[1].trim();
    return inner.replace(/\s*\([^)]*\)\s*$/, "").trim() || inner.trim();
  }

  function splitColon(s) {
    const m = s.match(/^([^:]+?)\s*:\s+(.+)$/);
    if (!m) return null;
    const left = m[1].trim();
    const right = m[2].trim();
    if (!looksLikeName(left) || !looksLikeName(right)) return null;
    // don't split structural colons ("…: Vol. 53", "…: Part 2")
    if (/^(vol|pt|part|no|chapter|episode|act|season)\b/i.test(right)) return null;
    if (/^\d/.test(right)) return null;
    return { left, right };
  }

  // Main entry. hint = { metaTrack, metaArtist, author }. author is the
  // YouTube channel / videoDetails.author ("- Topic" already stripped is fine).
  function parseTitle(rawTitle, hint) {
    hint = hint || {};
    const author = cleanArtist((hint.author || "").replace(/\s*-\s*topic\s*$/i, ""));
    const candidates = [];
    const pushExp = (a, t) => { for (const c of expandArtists((a || "").trim(), (t || "").trim())) candidates.push(c); };

    // 1. Trusted YouTube metadata, but only when the track has no dash (a
    //    dashed metadata track is just the raw video title — the dash logic
    //    below parses it better). Staleness-guarded against SPA navigation.
    if (hint.metaTrack && metadataMatchesTitle(hint.metaTrack, rawTitle)) {
      let t = cleanTitle(hint.metaTrack);
      const ma = cleanArtist((hint.metaArtist || "").replace(/\s*-\s*topic\s*$/i, ""));
      if (ma) t = stripArtistFromTrack(ma, t);
      if (t && !/\s+[-–—]\s+/.test(t)) {
        if (ma) pushExp(ma, t);
        else candidates.push({ artist: "", track: t });
      }
    }

    const title = cleanTitle(rawTitle);

    // 2. Spotify "Track · Artist"
    if (title.includes(" · ")) {
      const [song, artist] = title.split(" · ");
      pushExp(artist, song);
      return finalize(candidates, title, author);
    }

    // 3. Quoted track — `Artist "Track"` (does NOT return; keep as a strong
    //    candidate then let later branches add fallbacks).
    const quoted = extractQuoted(title);
    if (quoted) {
      const track = preferGloss(quoted.inner);
      const artist = cleanArtist(quoted.before);
      if (track) {
        if (artist) pushExp(artist, track);
        if (author) pushExp(author, track);
        candidates.push({ artist: "", track });
      }
    }

    // 4. Pipe-separated "Artist | Track | …"
    if (title.includes(" | ")) {
      const looksLikeNoise = (s) =>
        /^(?:\s*(?:official|music|video|audio|hd|hq|4k|1080p?|lyrics?|mv|visuali[sz]er))+\s*$/i.test(s);
      const isLabel = (s) =>
        /\b(records?|vevo|t-?series|entertainment|music\s+group|productions?|media|channel|tv)\b/i.test(s);
      const stripNum = (s) => s.replace(/^\d{1,2}[\s.\-]+/, "");
      const stripColonNoise = (s) => s.replace(/\s*:\s*(?:official|music|video|audio|lyrics?).*$/i, "").trim();
      const parts = title
        .split(/\s*\|\s*/)
        .map((s) => stripColonNoise(stripNum(s.trim())))
        .filter((s) => s && !looksLikeNoise(s) && !isLabel(s));
      if (parts.length >= 1 && /\s+[-–—]\s+/.test(parts[0])) {
        // first part is "Artist - Track"; trailing parts are album/label
        const segs = parts[0].split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
        const album = parts.slice(1).find((p) => !isLabel(p) && !looksLikeNoise(p)) || "";
        const a = segs[0], t = segs[1] || segs[0];
        for (const c of expandArtists(a, t)) candidates.push(album ? { ...c, album } : c);
        for (const c of expandArtists(a, t)) candidates.push(c);
        candidates.push({ artist: "", track: t });
        return finalize(candidates, title, author);
      }
      if (parts.length >= 2) {
        pushExp(parts[0], parts[1]);
        pushExp(parts[1], parts[0]);
        candidates.push({ artist: "", track: parts[0] });
        candidates.push({ artist: "", track: parts[1] });
        return finalize(candidates, title, author);
      }
      if (parts.length === 1) {
        candidates.push({ artist: "", track: parts[0] });
        if (author) pushExp(author, parts[0]);
        // fall through to dash/colon handling on the surviving part
      }
    }

    // 5. Dash-separated, segment aware ("Artist - Track - Live in …")
    const segs = title.split(/\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
    if (segs.length >= 2) {
      const core = segs.slice();
      while (core.length > 2 && isDescriptorSeg(core[core.length - 1])) core.pop();
      let a = core[0], t = core[1];
      // use the author hint to disambiguate direction when it clearly matches
      if (author && artistMatchStrong(core[1], author) && !artistMatchStrong(core[0], author)) {
        a = core[1]; t = core[0];
      }
      pushExp(a, t);
      pushExp(t, a);
      candidates.push({ artist: "", track: t });
      candidates.push({ artist: "", track: a });
      // also the whole right-of-first-dash (covers tracks that contain " - ")
      const firstDash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (firstDash) candidates.push({ artist: "", track: firstDash[2].trim() });
      return finalize(candidates, title, author);
    }

    // 6. Colon "Artist: Track"
    const colon = splitColon(title);
    if (colon) {
      pushExp(colon.left, colon.right);
      pushExp(colon.right, colon.left);
      candidates.push({ artist: "", track: colon.right });
      return finalize(candidates, title, author);
    }

    // 7. No separator — lean on the author hint, then try word-boundary splits
    if (author) {
      const stripped = stripArtistFromTrack(author, title);
      if (stripped && stripped !== title) {
        pushExp(author, stripped);
        candidates.push({ artist: "", track: stripped });
      } else {
        pushExp(author, title);
      }
    }
    const words = title.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 6) {
      // "Coldplay Yellow" → {Coldplay, Yellow}; "nipplepeople SUTRA" → {…, SUTRA}
      for (let i = 1; i < words.length; i++) {
        candidates.push({ artist: words.slice(0, i).join(" "), track: words.slice(i).join(" ") });
      }
    }

    return finalize(candidates, title, author);
  }

  // Append the whole-title floor candidate + author-confirmed variants, dedup.
  function finalize(candidates, title, author) {
    candidates.push({ artist: "", track: title });
    if (author) {
      const extra = [];
      for (const c of candidates) {
        if (c.track && !c.artist) extra.push({ artist: author, track: c.track });
      }
      for (const e of extra) candidates.push(e);
    }
    return dedupCandidates(candidates);
  }

  // ── LRCLib request building ────────────────────────────────────────────
  const LRCLIB_BASE = "https://lrclib.net";

  // The /api/search endpoints (free-text q + structured) are fast and already
  // return the synced rows, INCLUDING each row's `duration` — which scoreRow
  // uses to disambiguate recordings. /api/get is the exact "signature" endpoint
  // but is much slower under load (seconds), so we give it a short timeout and
  // treat it as a bonus: if the server is healthy it sharpens the match, if it's
  // slow it's dropped and the searches carry the lookup. This keeps the request
  // count and latency low so LRCLib doesn't throttle us into timeouts.
  const GET_TIMEOUT = 3500;
  const SEARCH_TIMEOUT = 5000;
  function buildLrclibRequests(cand) {
    const artist = (cand && cand.artist) || "";
    const track = (cand && cand.track) || "";
    const album = (cand && cand.album) || "";
    const durationSec = (cand && cand.durationSec) || 0;
    const reqs = [];
    const seen = new Set();
    const add = (url, kind, timeout) => {
      if (url && !seen.has(url)) { seen.add(url); reqs.push({ url, kind, timeout }); }
    };

    function getUrl(a, t, dur) {
      const p = new URLSearchParams();
      p.set("artist_name", a);
      p.set("track_name", t);
      if (album) p.set("album_name", album);
      if (dur && dur > 0) p.set("duration", String(Math.round(dur)));
      return `${LRCLIB_BASE}/api/get?${p.toString()}`;
    }

    if (artist && track) {
      // one signature get (folded artist/track — LRCLib usually stores ASCII)
      const fa = asciiFold(artist);
      const ft = asciiFold(track);
      const ga = fa || artist;
      const gt = ft || track;
      add(getUrl(ga, gt, durationSec), "get", GET_TIMEOUT);
      // structured ranked search (precise)
      const sp = new URLSearchParams();
      sp.set("track_name", track);
      sp.set("artist_name", artist);
      if (album) sp.set("album_name", album);
      add(`${LRCLIB_BASE}/api/search?${sp.toString()}`, "search", SEARCH_TIMEOUT);
    }
    if (track) {
      // free-text search — broadest recall, tolerant of messy artist strings
      const q = artist ? `${track} ${artist}` : track;
      add(`${LRCLIB_BASE}/api/search?q=${encodeURIComponent(q)}`, "search", SEARCH_TIMEOUT);
      const fq = asciiFold(q);
      if (fq && fq !== q.toLowerCase()) {
        add(`${LRCLIB_BASE}/api/search?q=${encodeURIComponent(fq)}`, "search", SEARCH_TIMEOUT);
      }
    }
    return reqs;
  }

  // ── Result scoring ─────────────────────────────────────────────────────
  // A row is accepted if its track fuzzy-matches OR (track is close AND the
  // artist strongly matches). Artist alone never rejects a track match.
  function accept(row, want) {
    if (fuzzyTrackMatch(row.trackName, want.track)) return true;
    if (!want.artist) return false;
    const a = normalizeForMatch(row.trackName);
    const b = normalizeForMatch(want.track);
    if (!a || !b) return false;
    const tol = Math.max(3, Math.floor(Math.max(a.length, b.length) * 0.3));
    return levenshtein(a, b) <= tol && artistMatchStrong(row.artistName, want.artist);
  }

  // Soft, capped duration penalty (video length ≠ audio length, so generous).
  function durationPenalty(rowDur, wantDur) {
    if (!rowDur || !wantDur || rowDur <= 0 || wantDur <= 0) return 0;
    const delta = Math.abs(rowDur - wantDur);
    const GRACE = 10;
    if (delta <= GRACE) return 0;
    return Math.min((delta - GRACE) / 5, 8);
  }

  // Lower is better. Synced is a *weighted bonus*, not an absolute gate, so a
  // correct-artist plain row can outrank a wrong-artist synced row (and vice
  // versa when the artists tie). Tuned so the synced bonus (~2) breaks ties and
  // covers a small track-title difference, but never beats a clear artist
  // mismatch (artist weight 0.6 × an edit distance of several chars).
  const ARTIST_WEIGHT = 0.6;
  const NEUTRAL_ARTIST_DIST = 5; // no-artist candidate — prefer artist-confirmed ones
  const SYNCED_BONUS = 2;
  function scoreRow(row, want) {
    const tDist = trackDistance(row.trackName, want.track);
    const aDist = !want.artist
      ? NEUTRAL_ARTIST_DIST
      : levenshtein(normalizeForMatch(row.artistName), normalizeForMatch(want.artist));
    const dPen = durationPenalty(row.duration, want.durationSec);
    const syncedBonus = row.syncedLyrics ? SYNCED_BONUS : 0;
    return tDist + ARTIST_WEIGHT * aDist + dPen - syncedBonus;
  }

  // rows: array of LRCLib result objects. want: {track, artist, durationSec}.
  // Returns {best, score, synced, alternatives} or null.
  function pickBest(rows, want) {
    const accepted = [];
    for (const r of rows || []) {
      if (!r) continue;
      if (!r.syncedLyrics && !r.plainLyrics) continue;
      if (!accept(r, want)) continue;
      accepted.push(r);
    }
    if (!accepted.length) return null;
    const scored = accepted
      .map((r) => ({ r, score: scoreRow(r, want), synced: !!r.syncedLyrics }))
      .sort((x, y) => x.score - y.score);
    // Dedupe AFTER scoring. LRCLib often returns the same title several times —
    // a plain copy AND a synced copy under the same artist/track. Deduping
    // first (and keeping whichever LRCLib listed first — usually the plain one)
    // would throw the synced row away. Scoring first means the synced row sorts
    // ahead (it has the synced bonus + a better duration match), so it's kept
    // and the redundant plain copy is the one dropped.
    const seen = new Set();
    const uniq = [];
    for (const s of scored) {
      const k = (s.r.artistName || "").toLowerCase() + "|" + (s.r.trackName || "").toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(s);
    }
    return {
      best: uniq[0].r,
      score: uniq[0].score,
      synced: uniq[0].synced,
      alternatives: uniq.slice(1, 6).map((s) => s.r),
    };
  }

  return {
    translit, asciiFold, normalizeForMatch, levenshtein, trackDistance,
    fuzzyTrackMatch, artistMatchStrong,
    cleanTitle, stripArtistFromTrack, expandArtists, dedupCandidates,
    metadataMatchesTitle, parseTitle, extractQuoted, preferGloss, splitColon,
    buildLrclibRequests, accept, scoreRow, pickBest, durationPenalty,
  };
});
