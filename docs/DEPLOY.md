# Karafilt — Deployment guide (Phase 6)

Two services deploy independently. The only hard rule: the shared secrets
(`FILTER_JWT_SECRET`, `USAGE_API_SECRET`) must be **identical** on both sides.

## 1. Website + API (Next.js → Vercel or any Node host)
1. Push the `website` repo to GitHub and import it into Vercel (or run `npm run
   build && npm run start` on any Node ≥ 20.9 host).
2. Set **all** environment variables in the host (from `website/.env.example`):
   - Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`
   - `NEXT_PUBLIC_SITE_URL` = your **production** domain (e.g. `https://karafilt.com`)
   - `ADMIN_EMAILS`
   - `FILTER_JWT_SECRET`, `USAGE_API_SECRET`
   - Paddle: `NEXT_PUBLIC_PADDLE_ENV=production`, `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`,
     `NEXT_PUBLIC_PADDLE_PRICE_ID`, `PADDLE_WEBHOOK_SECRET`
3. In Supabase → Authentication → URL config: add `https://<domain>/auth/confirm`
   to redirect URLs and set the Site URL to the production domain.
4. In Paddle → Notifications: point the webhook to `https://<domain>/api/paddle/webhook`.

## 2. Filtering backend (Python/Demucs → RunPod GPU pod)

Runs as an **hourly RunPod pod**: stop it whenever there are no Pro users and
pay nothing — the extension degrades gracefully to free WASM filtering while
it's off. RunPod's HTTP proxy terminates TLS, so there is no domain or
certificate to manage: exposing port 9876 yields a ready-made
`wss://<podid>-9876.proxy.runpod.net` endpoint.

**One-time image build** (or use the manual path below):
```bash
docker build -t ghcr.io/lemara98/karafilt-backend backend/
docker login ghcr.io          # GitHub username + a token with write:packages
docker push ghcr.io/lemara98/karafilt-backend
```
The image pre-bakes the htdemucs model (~1.5 GB) so pods serve immediately.

**Create the pod** (RunPod → Pods → Deploy):
- GPU: RTX A4000 / RTX 3090 class (~$0.17–0.31/hr) — htdemucs processes a 5 s
  chunk in ~1 s on a 3090, so one pod handles several concurrent streams.
- Container image: `ghcr.io/lemara98/karafilt-backend` (make the ghcr package
  public, or add registry credentials in RunPod).
- Expose **HTTP port 9876**; disk ≥ 20 GB.
- Environment variables:
  - `FILTER_JWT_SECRET` — same value as Vercel
  - `USAGE_API_SECRET` — same value as Vercel
  - `KARAFILT_USAGE_URL` = `https://karafilt.com/api/usage`
  - optional: `KARAFILT_WORKERS` (default 4), `KARAFILT_USAGE_INTERVAL` (default 30 s)

**Quick manual path** (first smoke test, no registry needed): deploy a stock
`runpod/pytorch` pod, open its web terminal, copy the `backend/` folder over
(or `git clone`), `pip install -r requirements.txt`, export the env vars, and
run `python server.py --device auto` inside `tmux`.

**Wire it to the website:** copy the pod's proxy address and set it in Vercel:
`AI_SERVER_URL=wss://<podid>-9876.proxy.runpod.net`, then redeploy. The
extension picks it up automatically via `/api/me` and `/api/filter-token` —
no extension update needed when the pod (and its URL) changes.

Notes:
- The constant audio-chunk traffic keeps the RunPod proxy's idle timeout from
  firing; the `websockets` server also pings every 20 s.
- With `FILTER_JWT_SECRET` set, the server requires a valid website-issued
  token per session and meters trial usage back to `/api/usage`.

## 3. Extension
- Defaults are production-ready: **Website URL** points at karafilt.com and the
  **Server URL** comes from the website (`AI_SERVER_URL`). Users only touch
  Settings to self-host (their own Server URL overrides the provisioned one).
- The CSP keeps `connect-src wss://*` because the backend endpoint is
  config-driven and self-hosting is supported; `scripts/package.sh` can pin a
  specific host via `PROD_WS_HOST` if a stable domain is adopted later.
- Submit to the **Chrome Web Store** when ready (the privacy policy at
  `/privacy` helps review).

## Smoke test (production)
1. Sign up on the live site → verify email → `/account` shows the trial.
2. In the extension (Website URL set), start an **AI** mode on a playing tab →
   filtering works → `/account` trial ticks down.
3. Let the trial lapse → AI falls back to free WASM with a "subscribe" prompt →
   subscribe via Paddle → `/account` flips to active → AI works again.

See `docs/OWNER_CHECKLIST.md` for the full go-live list.
