# Changelog

All notable changes to Karafilt are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] — 2026-07-31

### Added
- **Rate Karalyr karaoke lyrics.** When the lyrics you're playing come from
  Karalyr, 👍/👎 buttons appear next to the source badge — one tap tells
  karalyr.com whether the karaoke lyrics were good, helping the community
  surface the best sync for every song. No account needed, one vote per song
  version, and your vote is remembered.

### Changed
- **Words now fill like on karalyr.com.** The word being sung is revealed
  left to right with a glowing sweep — the same "liquid" word loading as
  Karalyr's own player — instead of the whole word lighting up at once.
  Words already sung hold the highlight colour, and lyrics with only line
  timing get a smooth estimated sweep across each word too.

## [1.2.0] — 2026-07-28

### Changed
- **Rating the filter is now a simple like/dislike.** The 1–5 star "Rate the
  filter" section is a single question — did the filter work? — answered with
  👍 or 👎. Ratings submitted before this change still count: 4–5 stars as
  likes, 1–3 stars as dislikes.
- **YouTube thumbnail badges show the community like share.** Voted videos now
  get a "👍 82%" badge (the share of voters the filter worked for) instead of
  a star average.

## [1.1.2] — 2026-07-26

### Added
- **A "Rate us on the Web Store" link** at the bottom of the side panel, beside
  the support link.

## [1.1.1] — 2026-07-24

### Added
- **A real count-in.** The thin loading strip that filled across intros and
  instrumental breaks is now the same count-in as on karalyr.com: the lyrics
  dim, a centered bar fills toward the downbeat, and a big number counts the
  seconds until the next line — in Karafilt's own colors.

### Changed
- **Sync requests fire immediately.** A song whose lyrics have no word timing
  is added to Karalyr's request queue as soon as it's identified and lyrics
  are found — no more waiting through 45–90 seconds of listening. Karalyr is
  checked first (by video id, then by name), so nothing already word-synced is
  ever re-requested; duplicates of an existing request become votes.

### Removed
- **The "Auto-request word-synced lyrics" toggle.** Requests are now always on
  while signed in. As before, only song metadata and the lyrics text are sent —
  nothing about your audio.
- **Dormant listen-along aligner files.** The experimental in-browser aligner
  (never enabled, never shipped in the store build) is gone along with the
  Karalyr endpoint it targeted; word timing comes from the sync queue instead.

## [1.1.0] — 2026-07-22

### Added
- **Spotify support.** Karafilt now works on open.spotify.com. Spotify never
  attaches its audio element to the page, so a bridge running in the page's own
  world captures it the moment it's created and relays playback position — the
  filter and lyrics follow along exactly as they do on YouTube.
- **Word-by-word lyrics.** Lyrics that carry real word timing now light up one
  word at a time instead of a line at a time, tracked smoothly against playback.
  Songs with only line timing keep the previous behaviour, and a
  "karalyr · word-sync" badge marks the ones with measured timing.
- **Karalyr as a lyrics source.** Lyrics are looked up in Karalyr — the open
  karaoke lyrics database — before the existing sources, matched by video id so
  the right version is found without guessing from the title.
- **Instrumental countdown.** Gaps longer than five seconds show a filling bar
  and the seconds remaining, instead of a frozen panel.
- **Automatic sync requests.** When you listen through a song whose lyrics have
  no word timing, it's quietly added to Karalyr's request queue so it can be
  timed for everyone. Requires being signed in; there's no button and nothing
  about your audio is sent.

### Changed
- **The party page can start the filter.** Starting a party from karafilt.com no
  longer always needs the share dialog — when the extension is already allowed on
  that tab it starts silently.
- Minimum Chrome version is now 111.

### Fixed
- Cancelling the screen-share dialog left the panel believing it was capturing.

## [1.0.0] — 2026-07-02

### Added
- **Auto-dismissing "Wrong song?" picker.** When several lyrics matches come back,
  the picker still opens by itself — but now a thin countdown bar drains over five
  seconds and, if you don't touch it, the picker folds away and keeps the default
  match. Hovering the list or clicking the toggle cancels the countdown.

### Changed
- **New toolbar icon.** The extension icon now matches the karafilt.com favicon —
  the K-bars glyph on the dark rounded square — at every size.
- **Party button facelift.** The header pill now uses the same 🎉 emoji as the
  website's party pages, with a gradient fill and glow to match the brand.
- **One-row rating.** The "Rate the filter" stars sit inline with the label, so
  the rating section takes about half the vertical space it used to.

### Fixed
- **Party page no longer shows "Vocals: OFF" while the filter is audibly running.**
  Capture state (and the current mode/removal settings) now survive the service
  worker being suspended mid-party, the page bridge is re-injected into open party
  tabs after an extension update/reload, and a stale bridge from a previous
  extension instance can no longer mask the live one's replies.
- The `Ctrl+Shift+K` toggle now hands its captured stream ID straight to the
  capture pipeline instead of requesting a second one outside the user gesture.

## [0.5.0] — 2026-06-26

### Added
- **Party Mode — a crowd-sourced karaoke jukebox.** A new **Party** button in the
  side-panel header starts a party and opens a host player page with a QR code.
  Guests scan it on their phones (no account needed), paste a YouTube link, and add
  songs to a shared, real-time queue. Songs play in order on the host's screen and
  auto-advance, with vocals filtered out — so everyone takes turns singing.
- **Synced lyrics on the party screen and guests' phones.** The party player shows
  time-synced, word-by-word lyrics beside the video — with font, size and
  highlight-colour controls, a focus (3-line) mode, and a "wrong song?" picker —
  and each guest's phone follows along in sync.
- **Vocal-filter controls on the party page.** The player page auto-connects to
  the extension and shows live **Vocals on/off** status plus the **mode** and
  **removal amount**, so you can run the whole party without opening the side
  panel. Start filtering panel-free by right-clicking the page (**Filter this tab
  with Karafilt**) or pressing `Ctrl+Shift+K`.
- **Party stats** — on your account page (parties hosted, songs queued/played,
  guests) and the admin dashboard (totals, hosts, guests, top party songs).

### Changed
- **Compact rating panel.** "Rate the filter on this song" now shows just the
  stars and the community rating; the optional comment box and Submit button
  appear only after you pick a star.

## [0.4.0] — 2026-06-25

### Added
- **Customizable lyrics.** A new Settings panel lets you pick the lyrics **font**
  (Default, Serif, Rounded, Monospace), scale the **font size** (80–200%), and
  choose the **highlight color** for the active line and currently-sung word —
  plus a **Reset to defaults** button. Your choices persist across sessions.
- **Edit your rating, with history.** When you revisit a song you've rated, the
  side panel pre-fills your previous stars and comment so you can update them.
  Re-rating now keeps the full edit history server-side (only your latest rating
  counts toward the community average).
- **Your usage stats.** Karafilt now records which songs you filter and for how
  long (while signed in) to power a new **"Your usage"** section on your account
  page: total time filtered, songs listened to, most-filtered songs, and a
  per-mode breakdown. A short note on the account page explains what's recorded.

### Changed
- **Much stronger Spectral Deep.** Deep mode now nulls the center vocal far more
  completely, widens the vocal band, and — unlike plain Spectral — also thins
  panned backing vocals and stereo harmonies in the vocal range, for an audibly
  more vocal-free (thinner) mix. Plain Spectral is unchanged.
- **Tidier Settings.** The "Account site" field was removed from the side panel
  (it stays on the default karafilt.com), and **Vocal Removal** now sits with
  **Mode** in one section.

### Notes
- Adds the `alarms` permission (used to keep usage timing accurate across the
  service worker's lifecycle). Usage stats require the karafilt.com backend and
  use your existing signed-in session — no audio ever leaves your browser.

## [0.3.0] — 2026-06-22

### Added
- **Rate the filter on each song.** A 1–5 star rating with an optional comment in
  the side panel lets you tell us how well vocal removal worked on the current
  song. Your rating is tied to the song and the active filter mode, and you can
  re-rate to update it.
- **Community ratings.** The side panel shows a song's average rating and number
  of ratings while you watch, and **rated videos get a `★` badge on their
  YouTube thumbnails** so you can gauge how well the filter works before opening
  them. Only aggregate averages are ever shown — individual ratings stay private.
  (Hide thumbnail badges with `localStorage.kflNoBadges = "1"`.)

### Notes
- Requires the karafilt.com backend (new ratings storage + admin analytics). No
  new extension permissions; ratings use your existing signed-in session.

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

[1.1.0]: https://github.com/lemara98/karafilt/releases/tag/v1.1.0
[1.0.0]: https://github.com/lemara98/karafilt/releases/tag/v1.0.0
[0.5.0]: https://github.com/lemara98/karafilt/releases/tag/v0.5.0
[0.4.0]: https://github.com/lemara98/karafilt/releases/tag/v0.4.0
[0.3.0]: https://github.com/lemara98/karafilt/releases/tag/v0.3.0
[0.2.1]: https://github.com/lemara98/karafilt/releases/tag/v0.2.1
[0.2.0]: https://github.com/lemara98/karafilt/releases/tag/v0.2.0
[0.1.0]: https://github.com/lemara98/karafilt/releases/tag/v0.1.0
