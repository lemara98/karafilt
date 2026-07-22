// Karafilt — site-adapter pure-helper tests (no DOM, no network)
//
//   node test/site-adapters.test.mjs
//
// Covers the Node-exported helpers of content/site-adapters.js: Spotify
// track-id extraction, progress-bar time parsing, and playhead interpolation.

import SA from "../content/site-adapters.js";

const C = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

let ok = 0;
let fail = 0;
function check(name, got, expected) {
  const pass = Object.is(got, expected);
  if (pass) ok++;
  else fail++;
  console.log(`  ${pass ? C.g("✓") : C.r("✗")} ${name} → ${JSON.stringify(got)}${pass ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

console.log(C.b("\n── trackIdFromHref ──\n"));
check("plain track href", SA.trackIdFromHref("/track/4uLU6hMCjMI75M1A2tKUQC"), "4uLU6hMCjMI75M1A2tKUQC");
check("full URL", SA.trackIdFromHref("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"), "4uLU6hMCjMI75M1A2tKUQC");
check("with query", SA.trackIdFromHref("/track/4uLU6hMCjMI75M1A2tKUQC?uid=abc&uri=x"), "4uLU6hMCjMI75M1A2tKUQC");
check("intl prefix", SA.trackIdFromHref("/intl-de/track/4uLU6hMCjMI75M1A2tKUQC"), "4uLU6hMCjMI75M1A2tKUQC");
check("episode (podcast)", SA.trackIdFromHref("/episode/5V4XZWqZQJvbddIcQZzQ5H"), null);
check("album", SA.trackIdFromHref("/album/4uLU6hMCjMI75M1A2tKUQC"), null);
check("short id", SA.trackIdFromHref("/track/4uLU6hMCjMI75M1A2tKUQ"), null);
check("long id", SA.trackIdFromHref("/track/4uLU6hMCjMI75M1A2tKUQCx"), null);
check("empty", SA.trackIdFromHref(""), null);
check("null", SA.trackIdFromHref(null), null);

console.log(C.b("\n── parseTimeText ──\n"));
check("m:ss", SA.parseTimeText("3:45"), 225);
check("mm:ss", SA.parseTimeText("12:07"), 727);
check("h:mm:ss", SA.parseTimeText("1:02:03"), 3723);
check("negative (remaining)", SA.parseTimeText("-1:30"), -90);
check("zero", SA.parseTimeText("0:00"), 0);
check("whitespace-padded", SA.parseTimeText(" 3:45 "), 225);
check("garbage", SA.parseTimeText("live"), null);
check("bare number", SA.parseTimeText("345"), null);
check("empty", SA.parseTimeText(""), null);
check("null", SA.parseTimeText(null), null);

console.log(C.b("\n── interpolate ──\n"));
check("playing: advances by wall-clock", SA.interpolate(10, 1000, false, 3500), 12.5);
check("paused: frozen", SA.interpolate(10, 1000, true, 3500), 10);
check("clock skew never rewinds", SA.interpolate(10, 5000, false, 4000), 10);
check("non-finite base → 0", SA.interpolate(NaN, 1000, false, 2000), 0);

console.log(`\n  ${C.b(`${ok}/${ok + fail}`)} assertions passed\n`);
process.exit(fail === 0 ? 0 : 1);
