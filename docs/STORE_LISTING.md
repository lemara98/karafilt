# Chrome Web Store listing — copy & submission answers

Everything to paste into the CWS developer dashboard. Build the zip with
`scripts/package.sh` (output: `dist/karafilt-<version>.zip`).

Still needed before submitting (manual):
- [ ] 3–5 screenshots, 1280×800 (side panel with synced lyrics on a YouTube
      video; the mode selector; the popup; karaoke focus mode)
- [ ] Small promo tile, 440×280 (wordmark on brand background — assets in `icons/`)
- [ ] Privacy policy live at `https://karafilt.com/privacy` (website repo)
- [ ] CWS developer account ($5 one-time)

---

## Store listing

**Name:** Karafilt

**Summary** (132 chars max):

> Real-time vocal remover for karaoke: strip vocals from any tab's audio and sing along with synced lyrics.

**Category:** Entertainment

**Language:** English

**Detailed description:**

> Turn any tab into a karaoke machine. Karafilt removes vocals from the audio
> of the tab you're watching — YouTube, streaming sites, anywhere music plays —
> and shows time-synced lyrics in the side panel so you can sing along.
>
> **How it works**
> Click the Karafilt icon (or press Ctrl+Shift+K) on a tab playing music.
> Karafilt captures the tab's audio, filters out the vocals in real time, and
> looks up the song's lyrics automatically.
>
> **Features**
> • Real-time vocal removal — no uploads, no waiting
> • Two free filter modes that run entirely in your browser (WebAssembly):
>   Spectral (frequency-selective, keeps bass and stereo) and Basic (fast
>   center-channel cancellation)
> • Synced lyrics with karaoke highlighting, from LRCLib (with Lyrics.ovh and
>   Genius fallbacks) — including a focus mode that shows the current lines big
> • Pick the right match when a song has multiple versions
> • Vocal/instrumental mix slider — keep a hint of the original vocal as a guide
> • Works on any site that plays audio
>
> **Karafilt Pro (optional)**
> The free modes are yours forever. Pro adds studio-grade AI separation
> (Demucs) running on our GPU servers for noticeably cleaner vocal removal —
> with a free trial. The extension is also self-hosting friendly: point it at
> your own server if you run the open-source backend.
>
> **Privacy**
> Free filtering happens 100% locally — your audio never leaves the browser.
> Song titles are sent to lyrics databases to find lyrics. Audio is only sent
> to a server in AI mode, to the server you choose, and is processed in memory
> — never stored. Karafilt is open source: https://github.com/lemara98
>
> Privacy policy: https://karafilt.com/privacy

---

## Privacy tab

**Single purpose description:**

> Karafilt removes vocals from the audio of the current tab in real time for
> karaoke and displays synchronized lyrics for the playing song in the side
> panel.

**Permission justifications:**

| Permission | Justification to paste |
|---|---|
| `tabCapture` | Core function: captures the current tab's audio so vocals can be filtered out in real time. Capture starts only on explicit user action (toolbar click, keyboard shortcut, or context-menu item) and stops when the user stops it or leaves the page. |
| `offscreen` | MV3 service workers cannot run the Web Audio API. The offscreen document hosts the audio processing graph (WebAssembly worklet) that filters the captured tab audio. |
| `activeTab` | Grants the temporary right to capture the tab the user invoked Karafilt on, preserving the user-gesture requirement of tabCapture without prompting a screen picker. |
| `tabs` | Used to detect when the captured tab navigates to another page (capture is stopped) and to address the active tab when the user starts filtering from the side panel. |
| `storage` | Stores user settings: filter mode, vocal/instrumental mix, lyrics on/off, server address. |
| `sidePanel` | The side panel is the main UI: synchronized lyrics, filter controls, and settings. |
| `scripting` | Injects the lyrics content script into tabs that were already open when the extension was installed or re-enabled, so lyrics work without reloading those tabs. |
| `contextMenus` | Adds a "Filter this tab" right-click item as an alternative way to start filtering with a clean user gesture. |
| Host permission `<all_urls>` | Karafilt works on any website that plays audio (YouTube, streaming services, web radios…). The content script reads the page's media title and playback position to find and synchronize lyrics for whatever the user is listening to; the user chooses when filtering starts. |

**Remote code:** No, I am not using remote code. (All code, including the
WebAssembly DSP module, is bundled in the package. AI mode sends *audio data*
to a server and receives *audio data* back — no code is fetched or executed.)

**Data usage — what the extension collects:**

- ✅ **Website content** — the page/media title and playback position of the
  tab, sent to lyrics services (lrclib.net, lyrics.ovh, genius.com) solely to
  find matching lyrics. In AI mode only, the tab's audio is streamed to the
  processing server the user configured (Karafilt Pro or self-hosted) and
  discarded after processing.
- ❌ Personally identifiable information, health, financial, authentication,
  personal communications, location, web history, user activity — not collected.
  (Pro sign-in happens on karafilt.com, not in the extension; the extension only
  presents the site's own session cookie when requesting a filter token.)

**Certifications (tick all three):**
- Not sold to third parties, outside of approved use cases
- Not used or transferred for purposes unrelated to the item's core functionality
- Not used or transferred to determine creditworthiness or for lending purposes

**Privacy policy URL:** `https://karafilt.com/privacy`

---

## Distribution

- **Visibility:** Public
- **Pricing:** Free (Pro is sold on karafilt.com via Paddle — not an in-store payment)
- **Regions:** All regions
