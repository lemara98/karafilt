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

## Market versions

The same reel renders with another market's captions via a query parameter:

```
karafilt-reel.html?lang=hi     # also vi, id, fil, zh_TW
```

The caption sets live in the `COPY` map near the bottom of
`karafilt-reel.html`; English lives in the markup and is the source of truth.
Two things stay English everywhere on purpose: the product name and the
"Start Filtering" button, which is the literal label in the extension's
English UI. Scene 3's localized lyrics are lines written for the reel, not
taken from a real song.

**All caption sets are machine-translated drafts awaiting a native speaker** —
see [`../docs/TRANSLATING.md`](../docs/TRANSLATING.md). Don't publish one that
hasn't been read.

## Regenerating

```bash
node marketing/tools/capture.js              # English  -> preview/
node marketing/tools/capture.js --lang=hi    # a market -> preview/hi/
```

Requires Chromium available to Playwright. The script picks Playwright up from
wherever it is installed; if it can't find it, point it at one:

```bash
PLAYWRIGHT_PATH=/path/to/node_modules/playwright node marketing/tools/capture.js
```

Each language run writes ~5 MB (WebM + GIF + 5 stills), so think before
committing all of them. The logo GIF is language-independent and is only
produced by the English run.

To change copy, scenes, timing, or colors, edit `karafilt-reel.html` — the scene
list and durations are in the `scenes` array near the bottom; brand colors are
CSS variables in `:root`.
