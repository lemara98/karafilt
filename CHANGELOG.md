# Changelog

All notable changes to Karafilt are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-06-22

### Added
- **Right-to-left lyrics support.** Lyric lines now auto-detect their text
  direction, so songs in RTL scripts (Arabic, Hebrew, Persian/Farsi, Urdu)
  render correctly right-to-left — including the per-word karaoke highlight.
  Detection is per line, so mixed-language songs display each line in its own
  correct direction, and left-to-right songs are unaffected.

### Changed
- Packaging script tidy-ups for the Chrome Web Store build (internal).

## [0.2.0] — 2026-06-20

### Changed
- **Karafilt is now fully free.** Removed the paid Pro tier and the server-side
  AI processing path; all vocal removal runs locally in the browser.

## [0.1.0] — 2026-06-17

Initial public release.

### Added
- **Real-time vocal removal** for any tab's audio, powered by an in-browser
  WASM DSP engine — no account or upload required.
- **Multiple removal modes:** Basic, Spectral, and a free **Spectral Deep
  (Strong)** mode that catches center / near-center backing vocals.
- **Synced karaoke lyrics** in the side panel via LRCLib lookup, with
  lyrics.ovh and Genius fallbacks and word-by-word highlighting. Falls back to
  plain (unsynced) lyrics when no timed lyrics exist.
- **Per-tab pinned side panel** as the primary UI; the toolbar icon opens the
  panel without auto-starting, and filtering is started explicitly via the
  Start button or the `Ctrl+Shift+K` shortcut.
- **Account integration** with karafilt.com (account chip in the panel,
  Google + GitHub sign-in via a centered popup).
- Smoother, lower-latency audio pipeline (buffered, gapless playback) and
  refined LRCLib search (throttling, deduplication, progressive results).

[0.2.1]: https://github.com/lemara98/karafilt/releases/tag/v0.2.1
[0.2.0]: https://github.com/lemara98/karafilt/releases/tag/v0.2.0
[0.1.0]: https://github.com/lemara98/karafilt/releases/tag/v0.1.0
