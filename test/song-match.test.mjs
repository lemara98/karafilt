// Karafilt — song-match measurement harness
//
//   node test/song-match.test.mjs              offline candidate-generation assertions
//   node test/song-match.test.mjs --online     hit-rate vs LIVE LRCLib (new algorithm)
//   node test/song-match.test.mjs --baseline   hit-rate vs LIVE LRCLib (OLD algorithm)
//   node test/song-match.test.mjs --online --baseline   run both, print the delta
//
// Pure-Node (no deps): talks to LRCLib over the built-in https module so it
// runs on Node 16 (no global fetch).

import https from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import SM from "../shared/song-match.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(path.join(__dirname, "corpus.json"), "utf8"));

const ONLINE = process.argv.includes("--online");
const BASELINE = process.argv.includes("--baseline");

const C = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ── LRCLib over https (Node-16 friendly) ───────────────────────────────────
// The real extension looks up one song at a time; the harness hammers 40 in a
// row, so we cap concurrency + retry once to avoid LRCLib rate-limiting making
// the *measurement* (not the algorithm) flaky.
// Gentle concurrency avoids LRCLib's burst rate-limiting (which is what makes
// the harness slow — 429s turn into timeouts). Keepalive reuses sockets.
const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
const MAX_CONCURRENT = 8;
let active = 0;
const waiters = [];
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function release() {
  active--;
  if (waiters.length) { active++; waiters.shift()(); }
}
function getRaw(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { agent, headers: { "User-Agent": "karafilt-test/1.0 (https://karafilt.com)", Accept: "application/json" } },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve(null); }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}
async function getJson(url, timeoutMs = 7000) {
  await acquire();
  try { return await getRaw(url, timeoutMs); }
  finally { release(); }
}

function rowsFrom(responses) {
  const rows = [];
  for (const resp of responses) {
    if (!resp) continue;
    if (Array.isArray(resp)) rows.push(...resp);
    else rows.push(resp);
  }
  return rows;
}

const hintOf = (e) => ({ author: e.authorHint || "", metaTrack: e.metaTrack || "", metaArtist: e.metaArtist || "" });

// Is the chosen lyrics row actually the right song? (artist + track vs truth)
function isHit(best, e) {
  if (!best) return false;
  const trackOK = SM.fuzzyTrackMatch(best.trackName, e.trueTrack);
  const artists = [e.trueArtist, ...(e.altArtists || [])].filter(Boolean);
  const artistOK = artists.length === 0 || artists.some((a) => SM.artistMatchStrong(best.artistName, a));
  return trackOK && artistOK;
}

// ── NEW algorithm: parse → buildLrclibRequests → pickBest → global best ─────
// LRCLib's /api/search?q= returns a rich pool (often 100+ rows). To keep the
// harness fast against a slow server, we fetch only the search pools (capped),
// then score EVERY candidate against the shared pool — exercising the same
// parser + composite scoring the extension uses, with a fraction of the
// requests. (The extension additionally hits /api/get; the search pool already
// contains those exact rows, so the pick is the same.)
function searchUrls(candidates, dur) {
  const set = new Set();
  for (const c of candidates) {
    for (const r of SM.buildLrclibRequests({ ...c, durationSec: dur })) {
      if (r.url.includes("/api/search?q=")) set.add(r.url);
    }
  }
  return [...set];
}
async function resolveNew(e) {
  const candidates = SM.parseTitle(e.rawTitle, hintOf(e)).slice(0, 6);
  const dur = e.approxDurationSec || 0;
  const urls = searchUrls(candidates, dur).slice(0, 3);
  const rows = rowsFrom(await Promise.all(urls.map((u) => getJson(u))));
  const found = candidates
    .map((c) => SM.pickBest(rows, { track: c.track, artist: c.artist, durationSec: dur }))
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);
  const chosen = found[0] || null;
  return chosen ? { best: chosen.best, synced: chosen.synced } : { best: null, synced: false };
}

// ── OLD algorithm (faithful-ish reproduction of the pre-change behavior) ────
const OLD_SUFFIX = [
  /\s*\(official[^)]*\)/i, /\s*\[official[^\]]*\]/i,
  /\s*\(lyrics?[^)]*\)/i, /\s*\[lyrics?[^\]]*\]/i,
  /\s*\(audio\)/i, /\s*\(hd\)/i, /\s*\(4k\)/i,
  /\s*\(remaster(ed)?[^)]*\)/i, /\s*\(live[^)]*\)/i,
  /\s*\(feat\.?[^)]*\)/i, /\s*ft\.?\s+.+$/i,
  /\s*\(\d{4}[^)]*\)/, /\s*\| spotify$/i, /\s*- youtube$/i, /\s*- soundcloud$/i,
];
const oldClean = (s) => { let o = s || ""; for (const re of OLD_SUFFIX) o = o.replace(re, ""); return o.trim(); };
const oldNorm = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\b(hd|hq|4k|1080p?|audio|video|lyrics?|official|live|remaster(?:ed)?|remix|rmx|stereo|mono)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s(feat|ft)\s.*$/, "").trim();
function oldFuzzy(cand, req) {
  const a = oldNorm(cand), b = oldNorm(req);
  if (!a || !b) return false;
  if (a === b) return true;
  const tol = Math.max(2, Math.floor(Math.max(a.length, b.length) * 0.15));
  return SM.levenshtein(a, b) <= tol;
}
function oldExpand(artistStr, trackStr) {
  const out = [{ artist: artistStr, track: trackStr }];
  if (artistStr && /[,&]| feat\.? | ft\.? | x /i.test(artistStr)) {
    for (const a of artistStr.split(/\s*(?:,|&| feat\.? | ft\.? | x )\s*/i).map((s) => s.trim()).filter(Boolean)) {
      out.push({ artist: a, track: trackStr });
    }
  }
  return out;
}
function oldDedup(list) {
  const seen = new Set(), out = [];
  for (const c of list) {
    const k = `${(c.artist || "").toLowerCase()}|${(c.track || "").toLowerCase()}`;
    if (!c.track || seen.has(k)) continue;
    seen.add(k); out.push(c);
  }
  return out;
}
function oldParse(e) {
  const rawTitle = e.rawTitle;
  const candidates = [];
  if (e.metaTrack && SM.metadataMatchesTitle(e.metaTrack, rawTitle)) {
    let t = oldClean(e.metaTrack);
    if (e.metaArtist && t.toLowerCase().startsWith(e.metaArtist.toLowerCase() + " ")) {
      t = t.slice(e.metaArtist.length).replace(/^[\s\-]+/, "").trim();
    }
    if (t && !/\s+[-–—]\s+/.test(t)) {
      if (e.metaArtist) candidates.push(...oldExpand(e.metaArtist, t));
      else candidates.push({ artist: "", track: t });
    }
  }
  const title = oldClean(rawTitle);
  if (title.includes(" · ")) { const [song, artist] = title.split(" · "); candidates.push(...oldExpand(artist.trim(), song.trim())); return oldDedup(candidates); }
  if (title.includes(" | ")) {
    const noise = (s) => /^(?:\s*(?:official|music|video|audio|hd|hq|4k|1080p?|lyrics?))+\s*$/i.test(s);
    const parts = title.split(/\s*\|\s*/).map((s) => s.replace(/^\d{1,2}[\s.\-]+/, "").trim()).filter((s) => s && !noise(s));
    if (parts.length >= 2) {
      candidates.push(...oldExpand(parts[0], parts[1]), ...oldExpand(parts[1], parts[0]), { artist: "", track: parts[0] }, { artist: "", track: parts[1] });
      return oldDedup(candidates);
    }
  }
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) {
    candidates.push(...oldExpand(m[1].trim(), m[2].trim()), ...oldExpand(m[2].trim(), m[1].trim()), { artist: "", track: m[2].trim() }, { artist: "", track: m[1].trim() });
    return oldDedup(candidates);
  }
  candidates.push({ artist: "", track: title });
  return oldDedup(candidates);
}
function oldPick(rows, track) {
  const seen = new Set(), acc = [];
  for (const r of rows || []) {
    if (!r || (!r.syncedLyrics && !r.plainLyrics)) continue;
    if (!oldFuzzy(r.trackName, track)) continue;
    const k = `${(r.artistName || "").toLowerCase()}|${(r.trackName || "").toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k); acc.push(r);
  }
  if (!acc.length) return null;
  const wanted = oldNorm(track);
  const scored = acc.map((r) => ({ r, dist: SM.levenshtein(oldNorm(r.trackName), wanted), synced: !!r.syncedLyrics }))
    .sort((a, b) => (a.synced !== b.synced ? (a.synced ? -1 : 1) : a.dist - b.dist));
  return { best: scored[0].r, synced: scored[0].synced };
}
async function resolveOld(e) {
  const candidates = oldParse(e).slice(0, 8);
  // old per-candidate request: /api/get (a+t) + /api/search?q="track artist"
  const results = await Promise.all(
    candidates.map(async (c) => {
      const urls = [];
      if (c.artist && c.track) {
        const p = new URLSearchParams(); p.set("artist_name", c.artist); p.set("track_name", c.track);
        urls.push(`https://lrclib.net/api/get?${p.toString()}`);
      }
      const q = c.artist ? `${c.track} ${c.artist}` : c.track;
      urls.push(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      const responses = await Promise.all(urls.map((u) => getJson(u)));
      return oldPick(rowsFrom(responses), c.track);
    })
  );
  // old selection: first candidate (priority order) with a synced pick, else first found
  const synced = results.find((r) => r && r.synced);
  if (synced) return { best: synced.best, synced: true };
  const any = results.find((r) => r);
  return any ? { best: any.best, synced: any.synced } : { best: null, synced: false };
}

// ── Offline candidate-generation assertions ────────────────────────────────
function runOffline() {
  console.log(C.b("\n── Offline: candidate generation (no network) ──\n"));
  let pairOK = 0, trackOK = 0;
  const fails = [];
  for (const e of corpus) {
    const cands = SM.parseTitle(e.rawTitle, hintOf(e));
    const wantTrack = SM.normalizeForMatch(e.trueTrack);
    const wantArtist = SM.normalizeForMatch(e.trueArtist);
    const hasTrack = cands.some((c) => SM.normalizeForMatch(c.track) === wantTrack);
    const hasPair = cands.some(
      (c) => SM.normalizeForMatch(c.track) === wantTrack &&
        (!c.artist || SM.normalizeForMatch(c.artist) === wantArtist || SM.artistMatchStrong(c.artist, e.trueArtist))
    );
    if (hasTrack) trackOK++;
    if (hasPair) pairOK++;
    const mark = hasPair ? C.g("✓") : hasTrack ? C.y("~") : C.r("✗");
    console.log(`  ${mark} ${e.rawTitle}`);
    if (!hasPair) fails.push(e);
  }
  console.log(`\n  correct {artist,track} candidate: ${C.b(`${pairOK}/${corpus.length}`)} (${Math.round((100 * pairOK) / corpus.length)}%)`);
  console.log(`  correct track present (any cand) : ${C.b(`${trackOK}/${corpus.length}`)} (${Math.round((100 * trackOK) / corpus.length)}%)`);
  if (fails.length) {
    console.log(C.y("\n  Titles with no correct {artist,track} candidate:"));
    for (const e of fails) {
      console.log(C.dim(`    • ${e.rawTitle}`));
      console.log(C.dim(`        want: {${e.trueArtist} | ${e.trueTrack}}`));
      console.log(C.dim(`        got : ${SM.parseTitle(e.rawTitle, hintOf(e)).slice(0, 5).map((c) => `{${c.artist}|${c.track}}`).join("  ")}`));
    }
  }
  return { pairOK, trackOK };
}

// ── Online hit-rate ─────────────────────────────────────────────────────────
async function runOnline(resolver, label) {
  console.log(C.b(`\n── Online: ${label} vs live LRCLib ──\n`));
  const t0 = Date.now();
  // Resolve every entry concurrently — the global MAX_CONCURRENT request cap
  // throttles the actual request rate, so this is fast without rate-limiting.
  const resolved = await Promise.all(
    corpus.map((e) => resolver(e).then((r) => ({ e, r })).catch(() => ({ e, r: { best: null, synced: false } })))
  );
  let hits = 0, synced = 0;
  const misses = [];
  for (const { e, r: res } of resolved) {
    const hit = isHit(res.best, e);
    if (hit) { hits++; if (res.synced) synced++; }
    const mark = hit ? (res.synced ? C.g("✓ synced") : C.y("✓ plain ")) : C.r("✗ miss  ");
    const got = res.best ? `${res.best.artistName} — ${res.best.trackName}` : "(nothing)";
    console.log(`  ${mark}  ${C.dim(e.trueArtist + " — " + e.trueTrack)}  ${hit ? "" : C.dim("→ " + got)}`);
    if (!hit) misses.push({ e, got });
  }
  console.log(C.dim(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`));
  const pct = Math.round((100 * hits) / corpus.length);
  console.log(`\n  ${C.b(label)} hit-rate: ${C.b(`${hits}/${corpus.length}`)} (${pct >= 88 ? C.g(pct + "%") : pct >= 70 ? C.y(pct + "%") : C.r(pct + "%")}), of which synced: ${synced}`);
  if (misses.length) {
    console.log(C.y("\n  Misses:"));
    for (const m of misses) console.log(C.dim(`    • ${m.e.rawTitle}  →  ${m.got}`));
  }
  return { hits, synced, total: corpus.length };
}

(async () => {
  const off = runOffline();
  if (!ONLINE && !BASELINE) {
    console.log(C.dim("\n(run with --online to measure live LRCLib hit-rate, --baseline to compare the old logic)\n"));
    // exit non-zero if offline parsing regressed below a floor
    process.exit(off.pairOK >= Math.ceil(corpus.length * 0.85) ? 0 : 1);
  }
  let oldRes, newRes;
  if (BASELINE) oldRes = await runOnline(resolveOld, "OLD algorithm");
  if (ONLINE || !BASELINE) newRes = await runOnline(resolveNew, "NEW algorithm");
  if (oldRes && newRes) {
    console.log(C.b("\n── Delta ──"));
    console.log(`  OLD: ${oldRes.hits}/${oldRes.total} (${Math.round((100 * oldRes.hits) / oldRes.total)}%)   →   NEW: ${newRes.hits}/${newRes.total} (${Math.round((100 * newRes.hits) / newRes.total)}%)`);
  }
  console.log("");
})();
