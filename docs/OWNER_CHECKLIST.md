# Karafilt — Owner checklist (the manual steps only you can do)

Everything Claude builds is code/docs in the two repos. This file lists the
**human-only** steps — accounts, secrets, dashboards, migrations, deploys, legal
— for the current product: a **free** extension that filters audio in-browser
(WASM) and a free Next.js website that provides accounts. Do them when you're
ready; the code is written to degrade gracefully until each is in place.

Legend: 🔑 secret/env · 🗄️ database · ⚙️ dashboard/config · 🚀 deploy · 🧾 legal/business · 🧪 test

---

## 1 — Extension (build & load)
- [ ] ⚙️ Build the WASM filtering engine: `make phase2` (see
      [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for what it produces).
- [ ] 🧪 Load the unpacked extension (`chrome://extensions` → Developer mode →
      Load unpacked → the `karaoke-filter-plugin` folder) and confirm: lyrics
      show (synced **and** plain), in-browser WASM filtering works, and there are
      no console errors.

## 2 — Website foundation (Supabase)
- [ ] ⚙️ Use **Node ≥ 20.9** for the website: `nvm use 24`.
- [ ] ⚙️ Create a **Supabase** project (free tier). Copy from Project Settings → API:
      Project URL, anon public key, service_role key.
- [ ] 🔑 `cd website && cp .env.example .env.local`, then fill in
      `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
      `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAILS`, `GITHUB_TOKEN`, and
      `NEXT_PUBLIC_SITE_URL` (`http://localhost:3000` for dev).
- [ ] 🗄️ Run **all** SQL migrations in `website/supabase/migrations/` **in order**
      (`0001` → `0009`) via the Supabase SQL Editor. (`0009` drops the old billing
      tables — apply it too.)
- [ ] ⚙️ Supabase → Authentication: enable **Email** provider with **"Confirm email" ON**;
      set **Site URL** + add redirect URL `…/auth/confirm`. (Optional but recommended:
      set the Confirm-signup email template to
      `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/account`.)
      Optionally enable the **Google** and **GitHub** OAuth providers.
- [ ] 🔑 Make yourself admin: `ADMIN_EMAILS` is pre-filled with your email in
      `.env.example` — keep it in `.env.local` (or insert into `app_admins`).
- [ ] 🧪 `npm run dev` → sign up → click the email link → sign in → check `/account`
      and `/admin` (the user list).

## 3 — Deploy & go-live
- [ ] 🚀 Deploy the **website** (Vercel or similar): set all `.env` vars in the host
      (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
      `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAILS`, `GITHUB_TOKEN`), set
      `NEXT_PUBLIC_SITE_URL` to the production domain, and add that domain's
      `…/auth/confirm` to Supabase redirect URLs.
- [ ] 🧪 On production, verify the **sign-in gate** (extension probes `/api/me`),
      **local in-browser filtering**, and **self-serve account deletion** from
      `/account`.
- [ ] ⚙️ Set up donations: **GitHub Sponsors** (supported for Serbia) and **Ko-fi**;
      put the links where the code expects them (env/config — Claude will point to the spot).
- [ ] 🚀 Push both repos to **GitHub** as public; add the donation links to `FUNDING.yml`.
- [ ] 🧾 **Trademark** check on the name "Karafilt" before heavy branding.
- [ ] 🚀 Submit the extension to the **Chrome Web Store**: build the zip with
      `scripts/package.sh` (strips the dev-only localhost CSP entries), then use
      the ready-made listing copy + permission justifications in
      `docs/STORE_LISTING.md`. Still manual: screenshots, promo tile, the $5
      developer account, and a live `https://karafilt.com/privacy`.

---

See also: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md),
[`website/docs/SUPABASE_SETUP.md`](../../website/docs/SUPABASE_SETUP.md),
[`website/docs/ARCHITECTURE.md`](../../website/docs/ARCHITECTURE.md).
