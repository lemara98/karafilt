# Contributing to Karafilt

Thanks for your interest in Karafilt! This repo holds the **Chrome extension** and
the **Python/Demucs filtering server** (`backend/`). The web app + API lives in the
companion `website` repo.

## Licensing of contributions
This repo is **dual-licensed by component**:
- The **browser extension** is **MIT** (`LICENSE`).
- The **filtering server** under `backend/` is **AGPL-3.0** (`backend/LICENSE`).

By submitting a contribution you agree to license it under the license that
applies to the directory you're modifying. Don't paste code from other projects
unless its license is compatible and you attribute it.

## Getting started
1. Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for how the pieces fit
   together, and [`README.md`](./README.md) for install/build steps.
2. Load the unpacked extension (`chrome://extensions` → Developer mode → Load
   unpacked).
3. For backend work, see the "Running the Backend Server" section of the README.

## Ground rules
- Keep changes small and focused; one logical change per PR.
- The **free in-browser path must keep working with no server and no account.**
- Don't add lyric transcription/alignment to the backend — lyrics are a pure
  third-party database lookup by design (see `docs/ARCHITECTURE.md`).
- Match the surrounding code style. Run any existing tests
  (`node test/song-match.test.mjs`) before opening a PR.
- Be clear in your PR description about what you changed and how you verified it.

## Reporting bugs / ideas
Open an issue with steps to reproduce (for bugs) or the use case (for features).
For anything security-related, please report privately rather than in a public
issue.
