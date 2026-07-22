#!/usr/bin/env bash
# Build the Chrome Web Store zip for Karafilt.
#
# The repo doubles as the dev workspace (backend/, docs/, test/, wasm sources),
# so the zip is built from an explicit WHITELIST — never from the repo root.
# The manifest CSP is also transformed for production: the localhost entries
# used for local development (website on :3000, backend on ws://:9876) are
# stripped so the shipped manifest contains no dev endpoints.
#
# Once the production AI host is fixed, set PROD_WS_HOST (e.g.
# "wss://ai.karafilt.com") to pin the CSP to it instead of the wss://*
# wildcard that currently allows self-hosted servers.
#
# Usage: scripts/package.sh        → dist/karafilt-<version>.zip
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PROD_WS_HOST="${PROD_WS_HOST:-}"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# ── Whitelist: everything the extension needs at runtime, nothing else ──────
FILES=(
  service-worker.js
  offscreen.html
  offscreen.js
  worklet-processor.js
  LICENSE
)
DIRS=(
  sidepanel
  shared
  icons
)

for f in "${FILES[@]}"; do cp "$f" "$STAGE/"; done
for d in "${DIRS[@]}"; do cp -r "$d" "$STAGE/"; done
# The side panel is the only UI surface; its shared styles live in
# sidepanel/base.css and ship as part of the sidepanel/ dir copied above.
# Only the manifest-declared content scripts. yt-captions-injector.js stays
# out: it's the disabled MAIN-world caption interceptor (see
# ENABLE_YT_CAPTION_EXTRACTION in lyrics-overlay.js) — dead code that would
# only invite Chrome Web Store review questions.
mkdir -p "$STAGE/content"
cp content/lyrics-overlay.js "$STAGE/content/"
cp content/site-adapters.js "$STAGE/content/"
cp content/spotify-bridge.js "$STAGE/content/"
cp content/yt-rating-badges.js "$STAGE/content/"
cp content/yt-rating-badges.css "$STAGE/content/"
cp content/party-bridge.js "$STAGE/content/"
mkdir -p "$STAGE/wasm/build"
cp wasm/build/vocal_remove.wasm "$STAGE/wasm/build/"

# ── Production manifest: strip dev-only CSP entries ─────────────────────────
python3 - "$STAGE" "$PROD_WS_HOST" <<'PY'
import json, sys

stage, prod_ws_host = sys.argv[1], sys.argv[2]
manifest = json.load(open("manifest.json"))

csp = manifest["content_security_policy"]["extension_pages"]
drop = {"ws://localhost:*", "http://localhost:3000", "http://127.0.0.1:3000"}
parts = []
for token in csp.split():
    if token in drop:
        continue
    if prod_ws_host and token == "wss://*":
        token = prod_ws_host
    parts.append(token)
manifest["content_security_policy"]["extension_pages"] = " ".join(parts)

# Strip dev-only localhost match patterns from content scripts (e.g. the party
# bridge), mirroring the CSP stripping above — no localhost reference may ship.
for cs in manifest.get("content_scripts", []):
    if "matches" in cs:
        cs["matches"] = [m for m in cs["matches"]
                         if "localhost" not in m and "127.0.0.1" not in m]

json.dump(manifest, open(f"{stage}/manifest.json", "w"), indent=2)
PY

# ── Production service worker: empty the party dev-host list ────────────────
# Mirrors the manifest stripping above; the safety grep below insists no
# localhost literal ships anywhere.
python3 - "$STAGE" <<'PY'
import re, sys

stage = sys.argv[1]
path = f"{stage}/service-worker.js"
src = open(path).read()
out, n = re.subn(
    r'const PARTY_DEV_HOSTS = \[[^\]]*\];',
    "const PARTY_DEV_HOSTS = [];",
    src,
    count=1,
)
if n != 1:
    sys.exit("package.sh: PARTY_DEV_HOSTS assignment not found in service-worker.js")
open(path, "w").write(out)
PY

# ── Safety net: every manifest-referenced file must exist in the stage ──────
python3 - "$STAGE" <<'PY'
import json, os, sys

stage = sys.argv[1]
manifest = json.load(open(f"{stage}/manifest.json"))
missing = []

def check(p):
    if p and not os.path.exists(os.path.join(stage, p)):
        missing.append(p)

for cs in manifest.get("content_scripts", []):
    for p in cs.get("js", []) + cs.get("css", []):
        check(p)
check(manifest.get("background", {}).get("service_worker"))
check(manifest.get("side_panel", {}).get("default_path"))
if missing:
    sys.exit("package.sh: manifest references files missing from the stage: " + ", ".join(missing))
PY

# ── Safety net: no dev endpoints may survive in the shipped files ───────────
if grep -rn "localhost\|127\.0\.0\.1" "$STAGE" --include="*.js" --include="*.json" --include="*.html"; then
  echo "ERROR: localhost reference found in packaged files (see above)" >&2
  exit 1
fi

mkdir -p dist
OUT="$ROOT/dist/karafilt-$VERSION.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" .)

echo "Packaged: dist/karafilt-$VERSION.zip"
unzip -l "$OUT" | tail -1
