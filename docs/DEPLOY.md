# Karafilt — Deployment guide

Karafilt is **free** and all audio processing runs **in the browser**. There is no
audio backend to deploy. Two things ship: the **website** (accounts) and the
**extension** (Chrome Web Store).

## 1. Website + API (Next.js → Vercel or any Node host)
1. Push the `website` repo to GitHub and import it into Vercel (or run `npm run
   build && npm run start` on any Node ≥ 20.9 host).
2. Set the environment variables in the host (from `website/.env.example`):
   - Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`
   - `NEXT_PUBLIC_SITE_URL` = your **production** domain (e.g. `https://karafilt.com`)
   - `ADMIN_EMAILS`
   - optional: `GITHUB_TOKEN` (sponsors + contributors lists), `NEXT_PUBLIC_GA_ID`
     (leave empty in production — see `.env.example`)
3. In Supabase → Authentication → URL config: add `https://<domain>/auth/confirm`
   to redirect URLs and set the Site URL to the production domain.
4. Apply the database migrations and configure auth as described in
   [`website/docs/SUPABASE_SETUP.md`](../../website/docs/SUPABASE_SETUP.md).

## 2. Extension
- Defaults are production-ready: the **Website URL** points at karafilt.com, used
  only for the cookie-based `/api/me` sign-in probe. All filtering runs locally.
- Submit to the **Chrome Web Store** when ready (the privacy policy at `/privacy`
  helps review).

## Smoke test (production)
1. Sign up on the live site → verify email → `/account` shows your account.
2. In the extension, open the side panel → sign in → the sign-in gate clears.
3. Play a song in a tab → pick a mode → **Start Filtering** → vocals drop in real
   time, entirely in the browser.
4. On `/account`, the **delete account** button removes the account.

See `docs/OWNER_CHECKLIST.md` for the full go-live list.
