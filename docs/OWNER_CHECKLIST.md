# Karafilt — Owner checklist (the manual steps only you can do)

Everything Claude builds is code/docs in the two repos. This file lists the
**human-only** steps — accounts, secrets, dashboards, migrations, deploys, legal —
grouped by phase. Do them when you're ready; the code is written to degrade
gracefully until each is in place.

Legend: 🔑 secret/env · 🗄️ database · ⚙️ dashboard/config · 🚀 deploy · 🧾 legal/business · 🧪 test

---

## Phase 1 — Smart-sync removal (extension + backend)
- [ ] 🧪 Load the unpacked extension (`chrome://extensions` → Developer mode → Load
      unpacked → the `karaoke-filter-plugin` folder) and confirm: lyrics still show
      (synced **and** plain), WASM filtering works, AI filtering works, and there are
      no console errors about missing `ALIGN_*` handlers.

## Phase 2 — Website foundation (Supabase)
- [ ] ⚙️ Use **Node ≥ 20.9** for the website: `nvm use 24`.
- [ ] ⚙️ Create a **Supabase** project (free tier). Copy from Project Settings → API:
      Project URL, anon public key, service_role key.
- [ ] 🔑 `cd website && cp .env.example .env.local`, then fill in
      `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
      `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL` (`http://localhost:3000` for dev).
- [ ] 🗄️ Run **all** SQL migrations in `website/supabase/migrations/` **in order**
      (`0001` → `0005`) via the Supabase SQL Editor.
- [ ] ⚙️ Supabase → Authentication: enable **Email** provider with **"Confirm email" ON**;
      set **Site URL** + add redirect URL `…/auth/confirm`. (Optional but recommended:
      set the Confirm-signup email template to
      `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/account`.)
- [ ] 🔑 Make yourself admin: `ADMIN_EMAILS` is pre-filled with your email in
      `.env.example` — keep it in `.env.local` (or insert into `app_admins`).
- [ ] 🧪 `npm run dev` → sign up → click the email link → sign in → check `/account`
      and `/admin`.

## Phase 3 — Token trust boundary
- [ ] 🔑 Generate two secrets: `openssl rand -hex 32` (twice). Put **the same values**
      in the website `.env.local` **and** the backend env:
      `FILTER_JWT_SECRET`, `USAGE_API_SECRET`.
- [ ] 🔑 Backend env also needs `KARAFILT_USAGE_URL` (your site's `…/api/usage`).
- [ ] ⚙️ Backend: `cd backend && pip install -r requirements.txt` (adds `pyjwt`).
- [ ] 🧪 Logged in, open `…/api/filter-token` should return a token; a `curl` to
      `/api/usage` with `Authorization: Bearer <USAGE_API_SECRET>` should return `{ok:true}`.

## Phase 4 — Payments (Paddle, Merchant of Record)
- [ ] 🧾 Create a **Paddle** account and **confirm Serbian seller onboarding + Payoneer
      payout in writing** before relying on it (see `website/docs/MONETIZATION.md`).
- [ ] ⚙️ In Paddle: create the **product + recurring price**; copy the **price ID**,
      the **client-side token**, and the **webhook secret**.
- [ ] 🔑 Fill the Paddle env vars in `.env.local`:
      `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`, `NEXT_PUBLIC_PADDLE_PRICE_ID`,
      `NEXT_PUBLIC_PADDLE_ENV` (`sandbox`/`production`), `PADDLE_WEBHOOK_SECRET`.
- [ ] ⚙️ In Paddle → Notifications, add a **webhook** pointing to
      `…/api/paddle/webhook`, subscribed to `subscription.*` and `transaction.completed`.
- [ ] 🧪 Run a **sandbox** checkout; confirm `/account` flips to "Active subscription"
      and the `subscriptions` row + `entitlements.subscription_status` update.

## Phase 5 — Extension integration
- [ ] ⚙️ In the extension settings, set the **Website URL** (default production; use
      `http://localhost:3000` for local testing). Reload the unpacked extension.
- [ ] 🧪 End-to-end: sign in on the website, start **AI** filtering in the extension,
      confirm a token is fetched and filtering runs; watch the trial meter on `/account`
      tick down; let the trial expire and confirm it **falls back to free WASM** with a
      "subscribe" prompt.

## Phase 6 — Community, deploy & go-live
- [ ] 🚀 Deploy the **website** (Vercel or similar): set all `.env` vars in the host,
      set `NEXT_PUBLIC_SITE_URL` to the production domain, and add that domain's
      `…/auth/confirm` to Supabase redirect URLs.
- [ ] 🚀 Deploy the **backend** to an always-on **GPU host** (RunPod / Vast / Hetzner):
      install deps, set env (`FILTER_JWT_SECRET`, `USAGE_API_SECRET`,
      `KARAFILT_USAGE_URL`=prod, optional `--auth-token`), and expose it over **`wss://`
      with TLS**. Then add that `wss://` host to the extension's CSP (tell Claude the
      host and it'll update the manifest).
- [ ] ⚙️ Set up donations: **GitHub Sponsors** (supported for Serbia) and **Ko-fi**;
      put the links where the code expects them (env/config — Claude will point to the spot).
- [ ] 🚀 Push both repos to **GitHub** as public; add the donation links to `FUNDING.yml`.
- [ ] 🧾 **Trademark** check on the name "Karafilt" before heavy branding.
- [ ] 🧾 **Register the business** (Serbian *preduzetnik* on *paušal*) and open a
      **Payoneer** account before taking real payments; hire a Serbian accountant; set up
      compliant **FX repatriation** (see `website/docs/MONETIZATION.md`).
- [ ] 🚀 Submit the extension to the **Chrome Web Store**: build the zip with
      `scripts/package.sh` (strips the dev-only localhost CSP entries), then use
      the ready-made listing copy + permission justifications in
      `docs/STORE_LISTING.md`. Still manual: screenshots, promo tile, the $5
      developer account, and a live `https://karafilt.com/privacy`.

---

See also: `docs/ARCHITECTURE.md`, `docs/BUILD_BRIEF.md`,
`website/docs/SUPABASE_SETUP.md`, `website/docs/MONETIZATION.md`.
