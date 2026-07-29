# Chrome Web Store listing — copy & submission answers

Everything to paste into the CWS developer dashboard. Build the zip with
`scripts/package.sh` (output: `dist/karafilt-<version>.zip`).

> ⚠️ Karafilt is now **fully free and runs entirely in the browser** (no AI
> server, no Pro tier) and **requires a free account sign-in**. Re-capture the
> screenshots and re-read the data-usage answers below before submitting — the
> old listing claimed AI audio was streamed to a server and that no
> authentication data was used; both are no longer true.

Still needed before submitting (manual):
- [ ] 3–5 screenshots, 1280×800 — RE-CAPTURE: the UI changed (no AI modes, no
      toolbar popup, a sign-in gate, simplified settings). See runbook below.
- [x] Small promo tile: `store-assets/promo-tile-440x280.png`
- [x] Marquee (optional but used for feature placement): `store-assets/marquee-1400x560.png`
- [x] Privacy policy live at `https://karafilt.com/privacy`
- [x] CWS developer account
- [ ] Reviewer test account: because the extension requires sign-in, provide
      working **test credentials** in the dashboard's "Account required" /
      reviewer-notes field so Google can review past the login gate.

## Screenshot capture runbook (4 shots → exact 1280×800)

CWS requires exactly 1280×800 (or 640×400). Workflow: take ROUGH screenshots
(any size, OS screenshot tool — the side panel is browser chrome, so DevTools
can't capture it), drop them in `store-assets/raw/`, then ask Claude to
crop/scale them to exact spec into `store-assets/`.

**Prep (5 min):**
- Build + load what ships: `scripts/package.sh && unzip -o dist/karafilt-0.2.0.zip -d /tmp/karafilt-pkg`
  → `chrome://extensions` → Load unpacked → `/tmp/karafilt-pkg`.
- Use a CLEAN browser surface: fresh Chrome profile (or at least hide the
  bookmarks bar, close other tabs) and a YouTube session that is **signed out
  of Google** — your avatar/recommendations leak into shots otherwise.
  YouTube dark theme matches the panel's dark UI nicely.
- Be **signed in on karafilt.com** so the extension is past its sign-in gate
  (the default Website URL points there). Otherwise the panel shows the
  full-panel "Sign in to Karafilt" gate instead of the controls.
- All three modes run locally, so any of them is fine to show running.
- Songs with reliable synced LRCLib lyrics: mainstream chart hits work —
  e.g. The Weeknd "Blinding Lights", Adele "Someone Like You", Queen
  "Bohemian Rhapsody". Verify the panel badge says "(synced)" before shooting.

**The 4 shots** (click the icon on the music tab to open the side panel, then
press Start Filtering):
1. **Hero:** YouTube music video playing + side panel with synced lyrics,
   current line highlighted mid-song, filter running (status "Filtering").
   This is the listing's first impression.
2. **Karaoke focus mode:** same song, focus mode on — the big 3-line page view
   with the active line highlighted.
3. **Modes:** the mode dropdown open showing Spectral (Good) / Spectral Deep
   (Strong) / Basic (Fast) — all three free, in-browser.
4. **Alternatives picker:** the "other matches" dropdown open on a song with
   several versions (synced badges visible) — shows the user stays in control.

**After capturing:** drop the raw files in `store-assets/raw/`, tell Claude
which raw file maps to which shot, and the exact-size 1280×800 finals will be
produced for upload.

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
> and shows time-synced lyrics in the side panel so you can sing along. Free.
>
> **How it works**
> Sign in with your free Karafilt account, then click the Karafilt icon on a
> tab playing music — the side panel opens with the song's lyrics, pinned to
> that tab so the rest of your browsing is untouched. Press Start Filtering (or
> Ctrl+Shift+K) and the vocals drop out.
>
> **Features**
> • Real-time vocal removal — runs entirely in your browser (WebAssembly), no
>   uploads, no waiting
> • Three free filter modes: Spectral (frequency-selective, keeps bass and
>   stereo), Spectral Deep (also strips center backing vocals for a cleaner
>   karaoke mix), and Basic (fast center-channel cancellation)
> • Synced lyrics with karaoke highlighting, from LRCLib (with Lyrics.ovh and
>   Genius fallbacks) — including a focus mode that shows the current lines big
> • Pick the right match when a song has multiple versions
> • Vocal/instrumental mix slider — keep a hint of the original vocal as a guide
> • Works on any site that plays audio
> • Vote 👍/👎 on how well the filter worked on each song — YouTube thumbnails
>   show the community's like share, so you can spot karaoke-friendly videos
>   before opening them
> • Party Mode — host a karaoke party: friends scan a QR, add YouTube songs to a
>   shared queue from their phones, and everyone takes turns singing with synced
>   lyrics and vocals removed
>
> **Free, with an account**
> Karafilt is completely free. You sign in once with a free account; you can
> delete your account at any time from karafilt.com.
>
> **Privacy**
> Vocal removal happens 100% locally — your audio never leaves the browser.
> Song titles are sent to lyrics databases to find lyrics. Karafilt is open
> source: https://github.com/lemara98
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
| `storage` | Stores user settings: filter mode, vocal-removal amount, Sync/Focus toggles, and lyrics appearance (font, size, highlight color). |
| `sidePanel` | The side panel is the main UI: synchronized lyrics, filter controls, and settings. |
| `scripting` | Injects the lyrics content script into tabs that were already open when the extension was installed or re-enabled, so lyrics work without reloading those tabs. |
| `contextMenus` | Adds a "Filter this tab" right-click item as an alternative way to start filtering with a clean user gesture. |
| `alarms` | Runs a periodic (60-second) heartbeat only while filtering is active, so the duration of each filtering session is timed accurately for the user's own usage stats and is still saved if the MV3 service worker is suspended mid-song. No alarms run when filtering is off. |
| Host permission `<all_urls>` | Karafilt works on any website that plays audio (YouTube, streaming services, web radios…). The content script reads the page's media title and playback position to find and synchronize lyrics for whatever the user is listening to; the user chooses when filtering starts. It also reads the user's karafilt.com sign-in session to confirm the account is signed in. |

**Remote code:** No, I am not using remote code. All code, including the
WebAssembly DSP module, is bundled in the package. The extension only makes
data requests over the network (lyrics text, and a sign-in check against
karafilt.com) — no code is fetched or executed.

**Data usage — what the extension collects:**

- ✅ **Website content** — the page/media title and playback position of the
  tab, sent to lyrics services (lrclib.net, lyrics.ovh, genius.com) solely to
  find matching lyrics. The tab's audio is processed locally and is never
  transmitted anywhere.
- ✅ **Authentication information** — Karafilt requires a free account. The
  extension reads your existing karafilt.com sign-in session (cookie) to
  confirm you are signed in and to show your account email in the side panel.
  It never handles your password — sign-in happens on karafilt.com — and it
  does not transmit your session anywhere except back to karafilt.com itself.
- ✅ **User activity** — while you are signed in and actively filtering, Karafilt
  records which song you filtered (its title and a normalized per-song key
  derived from the tab URL), the filter mode, and how long the filter was active.
  This is sent to karafilt.com to power your own usage stats (total time, songs,
  per-mode breakdown) on your account page. If you vote on how well the filter
  worked on a song (a like/dislike with an optional comment), that vote is
  stored as ratings data with the same song info; only aggregate like/dislike
  counts are ever shown publicly. Only songs you actively filter are recorded —
  general browsing is not — and no audio is ever transmitted.
- ❌ Personally identifiable information (beyond the account email above),
  health, financial, personal communications, location, web history — not
  collected.

**Certifications (tick all three):**
- Not sold to third parties, outside of approved use cases
- Not used or transferred for purposes unrelated to the item's core functionality
- Not used or transferred to determine creditworthiness or for lending purposes

**Privacy policy URL:** `https://karafilt.com/privacy`

---

## Distribution

- **Visibility:** Public
- **Pricing:** Free (no in-store or external payments — Karafilt is free)
- **Regions:** All regions

---

## Versioning note

The store rejects an update whose `manifest.json` `"version"` is not higher
than the currently published one. This build is `1.2.0` (replaces the 1–5 star
filter rating with a like/dislike vote; YouTube badges now show the community
like share). If `1.2.0` or higher is ever already live, bump again before
zipping.
