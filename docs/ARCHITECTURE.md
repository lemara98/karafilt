# Karafilt — Architecture

Karafilt is two repositories, kept deliberately separate. **All audio processing
runs in the browser** — there is no audio backend.

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  karaoke-filter-plugin       │        │  website (Next.js 16)         │
│  ─────────────────────       │        │  ──────────────────           │
│  • Chrome MV3 extension       │        │  Web app + API:               │
│    - lyrics side panel        │        │   • register / login (SSO)    │
│    - in-browser WASM filter   │        │   • email verification        │
│    - tab audio capture        │        │   • reviews + feedback        │
│    - sign-in gate (/api/me)   │        │   • account deletion          │
│                               │        │   • admin user list           │
│  MIT                          │        │  MIT                          │
└─────────────────────────────┘        └──────────────────────────────┘
```

Karafilt is **free** and requires a free sign-in. Nothing about audio leaves the
user's machine — the website is used only for accounts.

## The two features

1. **Lyrics display (pure lookup).** The extension looks the song up in a lyrics
   database (LRCLib primary; optional Genius / Lyrics.ovh plain fallbacks) and
   shows whatever exists — **synced** (timestamped, highlight the active line) if
   available, **plain** otherwise. The extension does **not** transcribe or
   time-align lyrics.
2. **Vocal filtering (karaoke).** Three modes, all running locally in the browser
   via WebAssembly, with a 0–100% mix slider:
   - **Spectral (Good)** — medium-quality spectral filtering.
   - **Spectral Deep (Strong)** — higher quality; also strips center backing vocals.
   - **Basic (Fast)** — lower quality, lowest cost.

   All three are real-time and run on the audio thread. No server, no uploads.

## The two repos cooperate only to confirm sign-in

The extension requires the user to be signed in to a free Karafilt account. It
confirms this with a single cookie-based probe to the website:

```
1. User signs in on the website (email/password or Google/GitHub SSO)  ──►  session cookie
2. Extension calls the website: GET /api/me  (sends the session cookie)
       → signed in: the side panel unlocks filtering
       → not signed in: the side panel shows the sign-in gate
3. All filtering happens locally in the browser — the website is never
   involved in audio.
```

There is no token boundary, no usage metering, and no audio traffic between the
extension and the website. The only contract is the `/api/me` sign-in probe.

## Extension internals

```
sidepanel/      — main UI (lyrics, mode, mix slider, sign-in gate).
                  The toolbar icon opens the side panel; it is the only UI.
service-worker  — orchestrates capture lifecycle + lyrics lookups
offscreen.js    — audio capture (Web Audio API), out of view
worklet-processor.js — real-time WASM processing on the audio thread
wasm/           — C source & compiled WebAssembly (STFT, center-cancel)
```

Audio is captured from the active tab and processed in real time by the WASM
AudioWorklet (spectral / center-channel vocal cancellation), never uploaded.

## Hosting
- **website** — any Node host / Vercel. Stateless Next.js app + Supabase
  (auth + Postgres for profiles, reviews, admin, feedback).
- **extension** — distributed via the Chrome Web Store. No servers to run.
