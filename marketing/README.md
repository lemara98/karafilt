# Karafilt — marketing animations

Brand-matched, self-contained animations for presenting Karafilt (decks, store,
booth screens, social). Built only from the existing brand assets — the EQ-bar
logo, the purple gradient (`#8b7cff → #b46cff`), and the product taglines.

## What's here

| File | What it is |
|------|------------|
| `karafilt-reel.html` | The main ~22s looping promo reel (16:9, 1280×720). Open in any browser; press **F11** for full-screen presenting. No build step, no dependencies (web font loads from Google Fonts; falls back to system sans offline). |
| `logo-animated.svg` | The logo with its EQ bars animated like a live audio visualizer. Drop into a webpage, README, or slide. Loops forever; respects `prefers-reduced-motion`. |
| `preview/` | Pre-rendered outputs (see below). |
| `tools/capture.js` | Renders the HTML/SVG with headless Chromium and produces the previews. |
| `tools/gifenc.js` | Tiny dependency-free animated-GIF encoder used by the capture script. |

### The reel, scene by scene
1. **Logo build** — animated EQ mark + `karafilt.` wordmark, tagline "Turn any tab into a karaoke machine."
2. **Vocals out** — a vocal waveform lifts/fades away while the instrumental stays. "The vocals drop out. The music stays."
3. **Synced lyrics** — karaoke-style word-by-word highlight with a progress bar.
4. **Features** — real-time vocal removal · synced lyrics · 100% in-browser/free · works on any site.
5. **CTA** — logo + "Start Filtering" + karafilt.com.

## Pre-rendered previews (`preview/`)

- `reel.gif` — full reel as a looping GIF (plays inline anywhere, incl. mobile).
- `logo.gif` — animated logo loop.
- `karafilt-reel.webm` — full-quality video for slides/keynote.
- `still-1…5.png` — full-res frames, one per scene, for static slides.

## Regenerating

```bash
node marketing/tools/capture.js
```

Requires Chromium available to Playwright (preconfigured in this environment via
`PLAYWRIGHT_BROWSERS_PATH`). Outputs land in `marketing/preview/`.

To change copy, scenes, timing, or colors, edit `karafilt-reel.html` — the scene
list and durations are in the `scenes` array near the bottom; brand colors are
CSS variables in `:root`.
