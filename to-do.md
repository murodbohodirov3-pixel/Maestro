# Maestro Restore TODO

## Active

### Owner redesign (approved 2026-09-29)

- [x] Step 1 cleanup: removed the calendar and client CRM screens (owner and masters), the repeated page headings, the refresh toast and the footer; plain-language comparison labels; neutral "today" comparisons; Продажи opens on the month; the full sales list folds away.
- [x] Split payments: one sale paid partly by card and partly in cash, one client, one approval; pending total broken down by cash/card/QR. Frontend only; the api already accepted it.
- [x] Owner analytics: month forecast, "Что происходит" signals, 12-month trend, master card, returning-client share (`src/utils/insights.js`, `test/insights.test.js`).
- [x] Monthly revenue goal: `settings.monthly_revenue_goal` applied and recorded 2026-09-29; `api` deployed with the owner's approval and verified byte-for-byte with `functions download`; unauthenticated setSettings returns 401. The owner sets the goal value himself.
- [x] Comparisons use finished days only (`comparisonRanges`); "Подробнее" removed from Обзор; fines in the master card; clearer returning-clients tile; Новые/Постоянные columns removed from the master table.
- [x] Attendance register: every master has a status every day (`attendanceGrid`/`attendanceTotals`); masters see sales the owner rejected in the last 7 days until they acknowledge them; "Ишхона" shown as "Салон".
- [x] «Банк» design ported (2026-09-29): tokens, Onest/Unbounded, header with gear, bottom tab bar (Главная · Продажи · Расходы · Команда), Настройки (goal, shift/salon, deletion log), navy hero cards, ranking without crown, Команда with register, fines summary and master list, navy master earnings card.
- [ ] Polish pass after the owner uses it on his phone (tell apart what he wants changed).
  - [x] Masters list removed from Команда: it repeated «Мастера месяца» on Главная, which opens the same master card.
  - [x] A master who started after the comparison window shows «новый мастер» instead of "+100% · было 0" (Главная, Продажи, master card).
- [x] Commission by date (2026-09-29): `master_commission_rates` + insert trigger `trg_sales_set_commission_pct` stamp each new sale with the rate for its own date; the `maestro-commission-sync` pg_cron job (00:00 Tashkent) keeps `masters.pct` equal to today's rate. From 2026-10-01 Жамолиддин 45→50%, Мироншох 40→45%. Dry-run verified; all 1 862 existing sales and their commission total (166 643 150) unchanged.
- [ ] On 2026-10-01 check that the job flipped `masters.pct` (Жамолиддин 50, Мироншох 45) and that the first October sales carry the new rate.
- [x] Step 2: new light, blue visual design. Keep the approved structure: bottom tab bar (Главная · Продажи · Расходы · Команда) and a gear screen for theme, shift settings and the deletion log; count-up numbers, Telegram haptics, leader crown, record-day and all-approved moments. Second round (А «Кобальт», Б «Небо», В «Барбершоп») is on the owner's design canvas, waiting for a pick. The first mockups — the first mockups were not "wow" enough; needs another round of concepts before any code.

- [ ] Authenticated manual check: add one master payment and compare owner/finance screens.
- [ ] Verify one real two-turn owner-bot dialogue (`/today`, then a follow-up) and confirm Telegram webhook delivery; public health already reports all server features configured.
- [ ] Run the first approved Reels job through the local Higgsfield Pro worker, then install it as a background Windows task.

### Maestro AI client administrator

- [x] Stage 1: inspect and map the live Maestro, Supabase, Telegram, and Vercel paths without changing production data.
- [x] Stage 2: exact RU/UZ business knowledge base approved; 24 bilingual FAQ scenarios and the machine approval gate pass.
- [ ] Stage 3: launch a separate test-only customer Telegram administrator; do not reuse the owner analytics bot or mutate schedule data.

### Calendar and booking system

Retired from the UI on 2026-09-29 at the owner's request (no public booking link, customer bots switched off). Tables, the `api` actions and the `customer-*` functions are untouched; the open items below are on hold.

- [x] Design the protected calendar schema, service catalog, day-off status, appointment audit trail, and database-level overlap prevention.
- [x] Add the owner/admin calendar UI, each master's private calendar, appointment status controls, and the «Выходной» button in attendance.
- [x] Add an owner/admin-only CRM view with client search, return-client filters, consent visibility, and Excel export.
- [x] Apply the reviewed production migration and deploy the `api` function and frontend.
- [ ] Run authenticated owner/master end-to-end checks without creating fake production appointments.
- [x] Configure all five masters' daily working hours and verify real availability generation.
- [x] Connect the approved customer bot to the read-only production availability contract.
- [ ] After explicit approval, add idempotent protected creation of pending appointments from the customer bot.
- [x] Keep administrator confirmation as the permanent booking gate; do not enable automatic customer-bot booking.
- [x] Add the protected production notification ledger and claim/complete/fail contract for bot-created appointments.
- [ ] Verify the live 24-hour, 2-hour, and post-visit feedback delivery cycle before closing Maestro AI stage 8.

## Completed

- [x] Added audited appointment outcomes (`completed`, `cancelled`, `no_show`) with exact reasons, no-show CRM counters, and owner/admin client blocking enforced across all booking creation paths; existing records were left unchanged.

- [x] Added fail-closed Sentry monitoring for the React frontend and `api` Edge Function, with a shared PII scrubber, sentinel leak tests, source-map upload, and separate production projects.
- [x] Added an append-only owner-only audit ledger for fine, expense, debt, and debt-payment deletions, with atomic RPC deletes and paginated API reads.
- [x] Removed dormant browser-direct Supabase CRUD modules and duplicate root PWA assets; active React UI continues to use the `api` Edge Function gateway only.
- [x] Centralized master commission calculations in `src/utils/calculations.js`, with Node regression tests and an RLS baseline migration for the core operational tables; production migration history now records `20260722100917` as applied after verifying its DDL was already present as `20260710061940`.
- [x] Confirmed break point: `4130f28` replaced working HTML with React/Vite.
- [x] Confirmed remote Supabase function `api` is active and contains legacy actions.
- [x] Confirmed RLS was disabled during the original restoration; later verified the staged RLS migrations enabled it on all current public tables without public policies.
- [x] Added React legacy shell that loads and mutates data through Edge Function `api`.
- [x] Restored Telegram Mini App / Login Widget auth flow in React.
- [x] Added local source copy for `supabase/functions/api`.
- [x] Replaced automatic broken Telegram widget render with Telegram fallback and BotFather domain guidance.
- [x] Added mobile layout safeguards without changing formulas, API payloads, or database writes.
- [x] Designed owner approval to use an explicit marker so 18 legacy pending sales keep their existing totals.
- [x] Deployed Edge Function `api` v6 with owner approval actions and verified unauthorized requests return 401.
- [x] Audited 249 expense rows and section totals directly in Supabase without changing data.
- [x] Added payment creation time and new/returning client labels to master and owner views.
- [x] Restored lifetime investment calculations and added complete paginated API reads.
- [x] Made shift and salon settings collapsible.
- [x] Deployed Edge Function `api` v7 and confirmed expense totals remained unchanged.
- [x] Build passed; GitHub and Vercel production received the feature commit.
- [x] Production login gate loads without browser console or Vercel runtime errors.
- [x] Matched the supplied HTML visual system while retaining the current API and financial behavior.
- [x] Added palette controls, dark mode, payment chips, daily revenue chart, and the 540px mobile layout.
- [x] Verified the build and a 390px viewport without horizontal overflow or console errors.
- [x] Added a dedicated attendance view with period filters, punctuality colors, quick fines, and seven-day fine deletion protection.
- [x] Formatted all active money inputs with grouped thousands while typing.
- [x] Combined UZS and USD debt summaries/charts; added monthly payment-plan forecasts and selectable monthly repayment totals without changing debt balances.
- [x] Added Stage 1 Telegram AI team: curated read-only reports, coordinator, specialists, diagnostic tools, direct report commands, and deployment documentation.
- [x] Added the Instagram producer: weekly content planning, production-ready Reels/post packages, Higgsfield prompts, owner approval guardrails, commands, and tests.
- [x] Connected the owner's Higgsfield Pro account and added durable content jobs, explicit approval/cancellation, status tracking, and a local Seedance 2.0 worker that avoids separate Cloud API billing.
- [x] Verified the live Supabase project is healthy, all current public tables have RLS enabled, and remote functions `api`, `telegram-auth`, `agents-report`, and `agents-content` are active.
- [x] Verified the owner-agent public health endpoint reports Telegram, owner restriction, OpenAI, persistent conversation, Maestro reports, and content jobs configured; unauthenticated webhook requests return 401.
- [x] Upgraded analytics UX with previous-period comparisons, dual-series revenue charts, owner overview, pending badges, sortable master performance, average check, payment mix, and debt payoff dates.
- [x] Stabilized paginated reads and refined analytics with dated comparisons, chart/master figures, owner profit overview, and staged hidden navigation tabs.
