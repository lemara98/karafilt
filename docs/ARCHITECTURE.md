# Karafilt — Architecture

Karafilt is two repositories and two servers, kept deliberately separate.

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  karaoke-filter-plugin       │        │  website (Next.js 16)         │
│  ─────────────────────       │        │  ──────────────────           │
│  • Chrome MV3 extension       │        │  Web app + API:               │
│    - lyrics side panel        │        │   • register / login          │
│    - in-browser WASM filter   │        │   • EMAIL VERIFICATION        │
│    - tab audio capture        │        │   • billing (Stripe)          │
│  • backend/ : Python + Demucs │        │   • reviews + donations       │
│    real-time vocal separation │        │   • trial/subscription ledger │
│    (GPU) — AGPL-3.0           │        │   • /api/filter-token         │
│                               │        │   • /api/usage                │
│  MIT (extension)              │        │  MIT                          │
└─────────────────────────────┘        └──────────────────────────────┘
```

## The two features

1. **Lyrics display (pure lookup).** The extension looks the song up in a lyrics
   database (LRCLib primary; optional Genius / Lyrics.ovh plain fallbacks) and
   shows whatever exists — **synced** (timestamped, highlight the active line) if
   available, **plain** otherwise. The backend does **not** transcribe or
   time-align lyrics. The old WhisperX "smart-sync" forced-alignment path is being
   **removed**.
2. **Vocal filtering (karaoke).** Two tiers:
   - **Free** — in-browser WASM spectral/basic filtering. No server, no account.
   - **Paid** — server-side AI separation (Demucs) over WebSocket, higher quality,
     gated by the trial/subscription state held by the website.

## Trust boundary: how the two servers cooperate

The **website is the single source of truth** for identity, entitlement, and the
one-time trial meter. The GPU filtering server stays **stateless about
users and billing** — it only verifies a signed token.

```
1. User logs in on the website  ──────────────►  session
2. Extension asks the website:   POST /api/filter-token
       website checks: trial time left OR active subscription
       returns a short-lived signed JWT (~5 min): { userId, entitlement, exp }
3. Extension opens the filtering WebSocket, presenting the JWT
4. Filtering server verifies ONLY the JWT signature (no user-DB lookup),
       then separates audio in real time
5. Filtering server reports seconds-processed back:  POST /api/usage  (M2M auth)
       website decrements the one-time trial / records usage
6. Trial exhausted + no subscription  ──►  /api/filter-token refused
       ──►  extension falls back to free in-browser WASM filtering
```

### Why this shape
- All account / billing / email-verification / trial logic lives in **one** place
  (the website). The GPU box never sees a password or a card.
- The two deploy and scale **independently**: the website on a cheap/serverless
  host; the GPU server sized only for concurrent *active* audio streams.
- Trial/subscription limits are enforced **server-side**. The extension's
  "remaining trial time" display is informational only — never trust the client.

## API contract (shared across both repos — keep in sync)

This is the only thing the two repos must agree on. Treat it as the source of
truth; if it starts to drift, extract a small shared types package.

**`POST /api/filter-token`** (extension → website, authenticated by session) — *implemented (Phase 3)*
- `200`: `{ "token": "<JWT>", "expiresAt": <epoch_seconds>, "entitlement": "trial"|"subscription", "trialSecondsRemaining": number|null }`
- `401` unauthenticated · `403` `{ "reason": "email_unverified" }`
- `402`: `{ "reason": "trial_exhausted" | "trial_expired" | "no_subscription" }`
- `503` if not configured (missing Supabase or `FILTER_JWT_SECRET`)

**Filter JWT claims** (website signs HS256, filtering backend verifies)
- `sub`: userId · `entitlement`: `"trial"|"subscription"` · `email` · `iat`, `exp` (~5 min TTL)

**`POST /api/usage`** (filtering backend → website, machine-to-machine) — *implemented (Phase 3)*
- Auth: `Authorization: Bearer <USAGE_API_SECRET>`
- Body: `{ "userId": string, "secondsProcessed": number, "sessionId"?: string }`
- Effect: atomically adds processed seconds to the user's trial meter (service role,
  `add_trial_usage` RPC). The backend reports for `trial` sessions only.

**Configuration (env) — secrets must match across the two repos**
- Website: `FILTER_JWT_SECRET` (signs), `USAGE_API_SECRET` (verifies the usage caller).
- Backend: `FILTER_JWT_SECRET` (verifies — identical), `KARAFILT_USAGE_URL` (the
  website's `/api/usage`), `USAGE_API_SECRET` (identical), optional
  `KARAFILT_USAGE_INTERVAL` (default 30s). Requires `pyjwt`. All three are optional —
  unset, the backend keeps its old open / `--auth-token` behaviour.

## Free trial semantics
**Hybrid**, set once per account: a **time window** (`trial_starts_at` →
`trial_ends_at`, default 7 days) **AND** an **AI-processing cap**
(`trial_seconds_limit`, default 1 hour). The trial is active only while it is
inside the window AND under the cap — whichever is reached first ends it. The
window gives a clean "free for N days" offer; the cap protects GPU cost. Email
verification is required before the trial can be consumed (also the main defense
against throwaway-signup abuse). Admins can grant/adjust both dimensions per user
from the dashboard.

## Hosting (target)
- **website** — any Node host / Vercel. Stateless app + a database (users,
  subscriptions, trial ledger, reviews).
- **filtering server** — a GPU host. Options to evaluate: a dedicated GPU VPS vs.
  serverless GPU (Modal / Replicate / RunPod). Sized for concurrent active
  streams, not total signups. Near-real-time latency is the priority.

## Current vs. target state
- **Now:** extension + WASM filtering + Demucs backend + lyrics lookup all work.
  Smart-sync/WhisperX has been **removed** (Phase 1) — lyrics are a pure database
  lookup, shown as-is (synced if LRCLib has it, plain otherwise). The website is a
  marketing scaffold (no auth/DB/payments). There is no token boundary yet — the
  backend is open.
- **Target:** add accounts + email verification + billing + reviews + donations to
  the website (**Supabase** auth + Postgres); gate the Demucs backend (**always-on
  GPU pod**) behind the `/api/filter-token` + `/api/usage` trust boundary above
  (payments via **Paddle** Merchant of Record). See
  [`BUILD_BRIEF.md`](./BUILD_BRIEF.md) for the phased plan.

See [`BUILD_BRIEF.md`](./BUILD_BRIEF.md) for the full build prompt that drives the
refactor.
