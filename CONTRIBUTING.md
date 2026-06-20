# Contributing to Karafilt

Thanks for your interest in Karafilt! This repo holds the **Chrome extension** —
all in-browser, no backend server. The web app + API lives in the companion
`website` repo.

## Licensing of contributions
The Karafilt browser extension is **MIT** (`LICENSE`). By submitting a
contribution you agree to license it under MIT. Don't paste code from other
projects unless its license is compatible and you attribute it.

## Getting started
1. Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for how the pieces fit
   together, and [`README.md`](./README.md) for install/build steps.
2. Load the unpacked extension (`chrome://extensions` → Developer mode → Load
   unpacked).
3. The WASM module is built with Emscripten (`make phase2`) — see the README.

## Ground rules
- Keep changes small and focused; one logical change per PR.
- All vocal filtering runs **locally in the browser via WebAssembly** — keep it
  that way; don't add an audio backend.
- Don't add lyric transcription/alignment — lyrics are a pure third-party
  database lookup by design (see `docs/ARCHITECTURE.md`).
- Match the surrounding code style. Run any existing tests
  (`node test/song-match.test.mjs`) before opening a PR.
- Be clear in your PR description about what you changed and how you verified it.

## Reporting bugs / ideas
Open an issue with steps to reproduce (for bugs) or the use case (for features).
For anything security-related, please report privately rather than in a public
issue.
