# Store assets — v1.4.0 (September 2026)

Chrome Web Store images for the 1.4.0 release (side panel tabs: Me + Playlists).

| File | Size | Slot |
|------|------|------|
| screenshot-1-hero.png      | 1280×800 | Screenshot 1 — hero: lyrics + filtering |
| screenshot-2-me.png        | 1280×800 | Screenshot 2 — Me tab: stats, scoreboard, badges |
| screenshot-3-playlists.png | 1280×800 | Screenshot 3 — Playlists tab |
| screenshot-4-party.png     | 1280×800 | Screenshot 4 — Party mode |
| screenshot-5-anytab.png    | 1280×800 | Screenshot 5 — works on any tab |
| promo-tile-440x280.png     | 440×280  | Small promo tile |
| marquee-1400x560.png       | 1400×560 | Marquee promo |

## Regenerating

`src/` holds the HTML the images are rendered from (shot.css is shared). The
panel-*.png files inside are 2x captures of the REAL side panel taken from the
dev harness with staged data — recapture them after UI changes, then open each
shot-*.html in a browser viewport of exactly the target size and screenshot.
The party QR is decorative (not scannable) by design.
