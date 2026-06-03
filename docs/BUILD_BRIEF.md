# Karafilt — Build Brief

This is the prompt that drives the refactor from "extension + open backend" to
"simple open-source karaoke extension + paid, metered filtering backend." Paste
it into a fresh Claude / Claude Code session (with both repos available) to get an
audit, an architecture proposal, and a phased plan **before** any large refactor.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design this brief targets.

---

## Context — two repositories
This product spans two repos under `~/Desktop/karaoke/`:
- **karaoke-filter-plugin** — the Chrome MV3 extension (popup, side panel, content
  script, offscreen Web Audio capture, in-browser WASM vocal removal) PLUS the
  Python/Demucs real-time vocal-separation server (GPU) in its `backend/` folder.
  It also has a lyrics lookup (LRCLib primary; Lyrics.ovh + Genius plain fallbacks)
  and a "smart-sync" WhisperX forced-alignment feature that I want **removed**.
- **website** — a Next.js 16 app (App Router, React 19, Tailwind v4). Today it's a
  marketing-site scaffold (account, pricing, sponsors, feedback, docs pages) with
  **no** auth, DB, payments, or API routes. It will grow into the web app + API:
  accounts, email verification, login, billing, reviews, donations, and the
  trial/subscription ledger.

Keep it simple. Before large refactors, read both repos and give me a plan; don't
start until I approve.
NOTE: `website/AGENTS.md` warns Next.js 16 has breaking changes vs. older training
data — read `node_modules/next/dist/docs/` and pick auth/payment libraries known
to work with Next 16 / React 19 before wiring anything.

## Product scope

### Main feature 1 — Lyrics display (pure lookup, NO backend syncing)
- In the extension side panel, show lyrics for the song playing in the tab.
- If a database (primarily lrclib.net) has a SYNCED/timestamped version, show it
  synced and highlight the active line as the song plays. If only PLAIN lyrics
  exist, show them plain.
- REMOVE the existing smart-sync / forced-alignment / WhisperX path entirely and
  its backend deps. The backend must NOT transcribe or time-align lyrics. Lyrics
  are shown exactly as the database returns them.
- Keep sources small and simple: LRCLib primary; keeping Genius/Lyrics.ovh plain
  fallbacks is optional. Prefer simplicity/reliability over coverage.

### Main feature 2 — Vocal filtering (karaoke)
- Remove/attenuate vocals from the tab's audio in real time, with a 0–100% mix
  slider.
- Free tier: in-browser WASM filtering (already implemented; needs no server —
  keep it).
- Paid tier: server-side AI separation (Demucs), higher quality; requires a
  logged-in account gated by trial/subscription state.
- Free trial: every account gets a ONE-TIME 1-hour trial of server-side AI
  filtering — 1 hour of cumulative AI-processing time, granted once per account and
  non-recurring (no weekly/monthly reset), metered server-side. When exhausted,
  stop server-side processing gracefully, fall back to free in-browser filtering,
  and prompt to subscribe. Show remaining trial time in the UI.
- Keep server-side filtering as close to real-time as possible; minimizing latency
  is a top priority.

### Minor features (web app)
- User accounts: register, log in, and EMAIL VERIFICATION (required before the
  trial/paid backend can be used — also the main lever against trial abuse via
  throwaway signups).
- Manage subscription; see remaining one-time trial / usage.
- Payment for continued access after the one-time trial. Propose subscription vs.
  usage-credits and recommend one; default assumption is a simple monthly
  subscription unless you advise otherwise.
- Users can leave recommendations/reviews and make optional donations.

### Open source & community
- Open-source both repos to build a community.
- Donations on the repos (GitHub Sponsors / Open Collective / Ko-fi) and on the
  website.
- OSS hygiene in both repos: clear README, LICENSE, CONTRIBUTING, CODE_OF_CONDUCT,
  issue templates.

## Architecture — two servers, one source of truth
Two servers, kept SEPARATE, cooperating via a short-lived-token trust boundary,
with the WEBSITE as the single source of truth for entitlement + trial metering:
1. User authenticates on the website (extension opens the login flow) → session.
2. Before AI filtering, the extension calls the website API (e.g.
   `POST /api/filter-token`). The website checks "one-time trial time remaining OR
   active subscription" and, if OK, returns a short-lived signed JWT (~5 min)
   carrying userId + entitlement.
3. The extension opens the filtering WebSocket with that JWT.
4. The filtering server verifies ONLY the JWT signature (shared secret or the
   website's public key) — it never queries the user DB — then separates audio.
5. The filtering server periodically reports seconds-processed back to the website
   (`POST /api/usage`, machine-to-machine auth). The website decrements the
   one-time trial / records usage. One meter, one place.
6. When the trial is exhausted with no subscription, `/api/filter-token` is refused
   and the extension falls back to free in-browser WASM filtering.

Honor these consequences:
- The GPU filtering server stays stateless about billing/users; ALL
  account/billing/trial/email-verification logic lives only in the website.
- The two deploy and scale independently (website on Vercel/cheap host; GPU server
  sized for concurrent ACTIVE streams).
- Enforce trial/subscription on the server; the extension's display of remaining
  time is informational only — never trust the client.
- The only thing shared across repos is the API CONTRACT (JWT claims + /api/usage
  shape). Keep it documented and in sync; consider a small shared types package if
  it drifts.

## Constraints & principles
- Keep it simple; don't over-engineer. Fewer reliable features beat many fragile
  ones.
- The free in-browser path must keep working with no server, no account.
- Server-side filtering must stay near real-time.
- Be mindful of lyrics licensing: lyrics come from third-party databases, not AI
  generation.

## What I want from you, in order
1. Audit both repos: list exactly what to KEEP, REMOVE (explicitly the
   smart-sync/WhisperX/forced-alignment paths + deps), and REFACTOR.
2. Propose the clean target architecture for (a) the extension, (b) the website web
   app + API (auth, email verification, payments, reviews, donations, the
   entitlement/metering ledger), (c) the filtering server, including the exact
   token issuance, JWT verification, and /api/usage metering that enforces the
   one-time 1-hour trial and subscription state.
3. Recommend a concrete hosting setup for near-real-time GPU Demucs separation
   across concurrent users — rough monthly cost, latency/concurrency scaling, and
   how trial vs. paying users share capacity (dedicated GPU VPS vs. serverless GPU
   like Modal/Replicate/RunPod).
4. Recommend the website/auth/payments stack (hosted auth + email verification +
   Stripe) and how trial + subscription state gates the backend.
5. Recommend the open-source + donations setup for both repos.
6. Give me a phased delivery plan (MVP first) and flag any decisions you need
   before building.

Start with the audit (step 1) and architecture proposal (step 2). Ask about open
decisions rather than assuming.
