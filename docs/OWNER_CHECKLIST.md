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
- [x] ⚙️ Set up donations: **GitHub Sponsors** (supported for Serbia); bank
      transfer / invoice available on request via the sponsors page.
- [x] 🚀 Push both repos to **GitHub** as public; sponsors link added to `FUNDING.yml`.
- [ ] 🧾 **Trademark** check on the name "Karafilt" before heavy branding.
- [ ] 🚀 Submit the extension to the **Chrome Web Store**: build the zip with
      `scripts/package.sh` (strips the dev-only localhost CSP entries), then use
      the ready-made listing copy + permission justifications in
      `docs/STORE_LISTING.md`. Still manual: screenshots, promo tile, the $5
      developer account, and a live `https://karafilt.com/privacy`.

## 4 — Market launch: India / SEA / Chinese diaspora (v1.3.0)

The code for all of this is written, tested and committed in both repos. What
is left is the human-only half, in dependency order. Nothing below can be done
from a terminal by anyone but you.

**4a. Karalyr production - DONE 2026-08-03, verified**
- [x] 🚀 Deploy karalyr. `main` was already pushed and Vercel had shipped it:
      `/library?lang=hi` returns 200 with the language chips, track pages emit
      the new `generateMetadata` tags.
- [x] 🗄️ Migration `0012` is applied in production - the dump carries
      `language` on both `sync_jobs` and `tracks`, and `__drizzle_migrations`
      holds all 12.
- [x] 🗄️ Fresh verified backup taken (`~/karalyr-backups/karalyr-20260803-*.sql.gz`,
      132 KB, 17 tables, gzip-clean).
- [x] 🗄️ Song-key backfill: **no-op in production** - 11 active jobs, 0 keys
      change, 0 duplicates. The collision bug only affected rows written by the
      old code, and no non-Latin request had reached prod before the fix. New
      rows get correct keys at insert time, so there is nothing left to apply.
      Re-run the dry run any time with a read-only token:
      `URL=$(turso db show karalyr --url); TOKEN=$(turso db tokens create karalyr --read-only -e 1d);`
      `DATABASE_URL=$URL DATABASE_AUTH_TOKEN=$TOKEN npx tsx scripts/backfill-song-keys.ts`
      (`scripts/load-env.ts` does not override variables already in the
      environment, so this really does target production.)
- [x] ⚙️ Worker venv: this machine *is* the production worker
      (`~/.config/karalyr-worker.env` → `https://www.karalyr.com`), and
      `Unidecode 1.4.0` + `pythainlp 5.3.5` are installed and importable.
      Nothing to do.
- [x] 🗄️ **Fixed on the way through: the daily backup had been silently failing
      since the dump outgrew 200 lines.** `scripts/backup-db.sh`'s validity
      check piped into `head -200` and then into `grep -q`; both close the pipe
      early, SIGPIPE the writer, and `set -o pipefail` turned that into "dump
      looks empty or invalid". Every run from 2026-07-26 to 2026-08-03 aborted
      on a perfectly good dump. The guard now reads the head into a variable
      and greps a here-string. Verified through systemd, and the failed unit
      state was reset. **The fix is uncommitted in the karalyr repo.**
- [ ] 🧪 Smoke test: request a Hindi song from the extension → it appears in
      `/admin/queue` with the `hi` chip → promote → the worker aligns it →
      Devanagari lyrics sweep word by word on the track page.

**4b. Extension v1.3.0**
- [ ] 🧪 Load `dist/karafilt-1.3.0.zip` unpacked and walk the panel with a
      Hindi, a Chinese and a Vietnamese song (no empty boxes, sane sweep,
      titles matched).
- [ ] 🚀 Submit `dist/karafilt-1.3.0.zip` to the Chrome Web Store. The
      manifest, `CHANGELOG.md` and `docs/STORE_LISTING.md` are already at
      1.3.0. Reviewer test credentials are still required (sign-in gate).
- [ ] 🚀 After CWS acceptance, submit the **same zip** to **Edge Add-ons**
      (one-time, free reach - including Edge users in mainland China).
- [ ] 🚀 Publish the karafilt.com changelog (already written up to v1.3.0 in
      `website/src/app/changelog/page.tsx`) and, if you want, send the release
      as an opt-in broadcast from `/admin/emails`.

**4c. Localized listings and marketing (no code, no release cycle)**
- [ ] 🧾 Get each draft in [`docs/store-listings/`](./store-listings/) read by
      a native speaker before publishing it - the drafts are machine
      translations and say so. Process: [`docs/TRANSLATING.md`](./TRANSLATING.md).
- [ ] ⚙️ Add the reviewed languages in the CWS dashboard: Store listing → the
      language dropdown → Add language. Per-language listings are independent
      of the package; they can be added or fixed any time.
- [ ] ⚙️ Re-capture the promo reel per market:
      `node marketing/tools/capture.js --lang=hi` (also `vi`, `id`, `fil`,
      `zh_TW`) → `marketing/preview/<lang>/`. Same rule: reviewed captions
      only. Each run writes a few MB of GIF/WebM, so decide what is worth
      committing.
- [ ] 🧾 Recruit 1-2 community champions per market (Discord/Telegram) to seed
      the wanted-list, review the texts, and extend the per-market noise blocks
      and corpus rows. `docs/TRANSLATING.md` is the onboarding doc to hand them.
- [ ] 🧪 Watch the per-region install numbers in the CWS and Edge dashboards,
      and the per-language demand rollup on `/admin` - that decides which
      market gets attention next.

**4d. Held back on purpose (your call, each has a gate)**
- [ ] 🧪 **Thai word-level timing** is implemented but unverified. Run a real
      Thai track through the aligner and judge the sweep before advertising
      Thailand; the honest fallback is line-level sync (`--line-level`, the
      default for Khmer and Lao).
- [ ] 🧾 **UTM at signup** (first-touch attribution, one Supabase column) -
      needs the privacy page updated first. Not implemented.
- [ ] 🧾 **`ui_locale` in `filter_usage`** (which interface language installs
      come from) - needs the CWS Data Use disclosure updated first. Not
      implemented.
- [ ] 🧾 The reel's English scene-3 lyrics are four lines of a real, in-copyright
      song. The localized captions use lines written for the reel instead;
      consider doing the same for English.

---

See also: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md),
[`website/docs/SUPABASE_SETUP.md`](../../website/docs/SUPABASE_SETUP.md),
[`website/docs/ARCHITECTURE.md`](../../website/docs/ARCHITECTURE.md).
