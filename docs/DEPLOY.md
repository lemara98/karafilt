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

## 2. Filtering backend (Python/Demucs → always-on GPU host)
A dedicated GPU instance (RunPod / Vast.ai / Hetzner GPU) sized for concurrent
*active* streams. The first run downloads the Demucs model (~1.5 GB).
1. `cd backend && ./setup.sh` (or `pip install -r requirements.txt`).
2. Set env:
   - `FILTER_JWT_SECRET` (same value as the website)
   - `USAGE_API_SECRET` (same value as the website)
   - `KARAFILT_USAGE_URL` = `https://<domain>/api/usage`
   - optional `KARAFILT_USAGE_INTERVAL` (default 30s), `--auth-token`
3. Run `python server.py --device auto`. With `FILTER_JWT_SECRET` set, the server
   requires a valid website-issued token per session and meters trial usage.
4. **Terminate TLS** in front of it (Caddy/Nginx/Cloudflare) so the extension can
   connect over **`wss://your-backend-host`** — browsers won't open `ws://` from an
   `https://` page.
5. Add that `wss://` host to the extension's CSP `connect-src` in `manifest.json`
   (currently it allows `wss://*`, which already covers any host — tighten to your
   specific host before a Web Store submission).

## 3. Extension
- In the extension settings, set **Website URL** to the production site so AI modes
  fetch a filter token. The `serverUrl` (backend) setting should point at the
  `wss://` backend.
- Submit to the **Chrome Web Store** when ready (a tightened CSP and the privacy
  policy at `/privacy` help review).

## Smoke test (production)
1. Sign up on the live site → verify email → `/account` shows the trial.
2. In the extension (Website URL set), start an **AI** mode on a playing tab →
   filtering works → `/account` trial ticks down.
3. Let the trial lapse → AI falls back to free WASM with a "subscribe" prompt →
   subscribe via Paddle → `/account` flips to active → AI works again.

See `docs/OWNER_CHECKLIST.md` for the full go-live list.
