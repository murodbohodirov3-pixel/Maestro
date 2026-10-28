# AGENTS.md

Project instructions for Codex agents working on Maestro Barberia.

## Project

- This repository is the Maestro Barberia React + Vite frontend.
- Production URL currently known to the user: `https://maestro-pied-two.vercel.app/`.
- The app uses Supabase project ref `ivowbhraaistxvoymxpf`.
- Main local app code is under `src/`.
- Active runtime path: `src/main.jsx` renders `src/App.jsx`; frontend data calls go through `src/lib/legacyApi.js` to the `api` Edge Function.
- The former parallel page modules and browser-direct Supabase client were removed. Do not recreate or connect direct table CRUD from the frontend.
- Supabase local assets are under `supabase/`.
- Restoration source of truth: legacy single-file app `Maestro-main/index.html` version `v14` and the live Supabase Edge Function `api`.
- The current restoration goal is near 1:1 behavior parity with the old HTML app while keeping React/Vite as the frontend shell.

## Default Workflow

When making any code or configuration change:

1. Inspect the current worktree first.
2. Do not overwrite unrelated user changes.
3. Run the relevant verification command before finishing.
4. Commit the completed change.
5. Push the commit to GitHub.
6. Verify that Vercel received the pushed update.
7. Check the live Vercel deployment when the change affects user-visible behavior.

If Git, GitHub, or Vercel cannot be used, report the exact blocker immediately and do not pretend the push or deployment happened.

For large restoration work, maintain `to-do.md` in the project root:

- Add new discovered tasks as they appear.
- Mark completed tasks promptly.
- Compact completed detail into short summary bullets so the file stays useful.
- Keep `to-do.md` committed with the code changes it describes.

## GitHub Rules

- Before editing, run `git status --short --branch`.
- If the repository metadata is broken or missing, fix or report that before promising any push.
- After code changes, create a clear commit message and push it to the configured remote.
- Never commit `.env`, secrets, tokens, private keys, local caches, `node_modules`, or generated files unless the project explicitly requires them.
- If the user asks for a code update, assume they want it pushed to GitHub after verification unless they explicitly say not to push.

## Vercel Rules

- After every pushed code update, verify that Vercel has received the update.
- Prefer the Vercel connector/tools when available.
- If `.vercel/project.json` exists, use its `orgId` and `projectId`.
- If Vercel project metadata is unavailable, use the known production URL and explain what could and could not be verified.
- For UI changes, open the deployed site and confirm the visible behavior matches the change.
- Report deployment status clearly: queued, building, ready, failed, or unknown.

## Supabase Rules

- Treat Supabase as core to the product, not an afterthought.
- Before implementing features that touch data, roles, access, auth, Telegram login, finance, masters, sales, attendance, fines, expenses, or debts, inspect the relevant Supabase tables and local client code.
- Current known Supabase project ref: `ivowbhraaistxvoymxpf`.
- Current restoration backend: Edge Function `api`, endpoint `/functions/v1/api`, request shape `{ initData, tgAuth, action, payload }`.
- Business writes should go through `api` actions (`load`, `addSale`, `setSaleApproval`, `delSale`, `setAttendance`, `delAttendance`, `addFine`, `delFine`, `setSettings`, `addExpense`, `delExpense`, `addDebt`, `addDebtPayment`, `delDebtPayment`, `delDebt`, `setDebtClosed`, `setMasterSchedule`, `delMasterSchedule`, `addAdvance`, `delAdvance`, `markPayout`, `delPayout`, `setLanguage`, `addProductReceipt`, `addProductSale`, `setProductSaleApproval`, `addProductWriteoff`, `delStockEntry`, `setProductActive`) unless a later approved migration replaces this gateway.
- Master schedules are versioned: each row of `master_schedule_rules` belongs to the week that starts on its `effective_from`, and a day is judged by the master's latest version that has started (`scheduleRulesOn` in `src/utils/reporting.js`, the same rule in `agents-report` and in the slot functions). Change hours through `setMasterSchedule` (Настройки → График мастеров), never by editing rows in place: that would re-judge every day already worked.
- Склад (stock), since 2026-10-14: tables `products`, `product_receipts`, `product_sales`, `product_writeoffs`, written only through the `maestro_*` functions in `supabase/migrations/20261014160000_stock.sql`, which lock per product and refuse to sell or write off more than is on the shelf. A receipt paid by the salon, Мурод or Жамшид creates its expense (`category = 'stock'`) in the same transaction, and that expense can only be removed together with its receipt. A product sale's `amount` is what the salon kept after the seller's share; `unit_cost` is the average purchase price fixed at entry. An administrator's sale waits for the owner in the same «На подтверждение» queue as masters' sales (`approvalQueue` in `App.jsx`). Profit adds approved product sale amounts (`productIncome` in `src/utils/stock.js`), not their margin, because the purchase is already an expense.
- Roles (2026-10-16): `owner` decides everything; `finance` reads the figures and enters expenses; `partner` reads everything, takes bookings (`bookingSlots`, `addBooking`, `moveBooking`, `setAppointmentOutcome`, `searchClients`, `addClient`) and sets days off (`setMasterDayOff`) — `partnerMayCall`; `admin` is the front-desk administrator, who may `load` her own Склад view (names and quantities, no prices), `addProductSale` (always pending), `delStockEntry` on her own pending sale and the same booking actions; masters book nobody, they record the clients who come — the allowlist is `adminMayCall` in `supabase/functions/_shared/access.js`, checked right after the partner guard. The role named `admin` is not in `isAdmin` and approves nothing. Its load answers `role: 'frontdesk'`, which the app routes to `DeskStockView`.
- Calendar (2026-10-16): Команда → «Записи» (`BookingsView`) for the owner, the partner and the administrator (her screen: «Записи | Склад», no tab bar); «Мои записи» in a master's Рабочий день. A booking is closed by a visit (`addSale` with `appointment_id`, checked by `maestro_check_appointment_for_visit`, closed by `maestro_complete_appointment_for_visit`) or by `setAppointmentOutcome` with `no_show` / `cancelled`; the api refuses `completed` there. Booking secrets (`booking_token_hash`, `booking_ip_hash`, `booking_tg_user_id`) are stripped in `fetchAppointments`, and numbers are masked for masters.
- Client visits (2026-10-16): every new sale names its client (`sales.client_id`, with `client_name` and `client_no_phone` snapshots); `addSale` refuses one without `client_id` and decides `is_new_client` itself — new when the client has no visit (`maestro_client_visit_count`: counted sales plus the old calendar's completed bookings no sale stands for) and was not marked «был у нас раньше» (`clients.known_before`). That question is asked only when a card is made; a card picked from the base never asks it, and `addSale` takes no answer to it. One number is one card: `maestro_add_client_card` normalises the number and answers `client_exists`, and the app looks a whole number up while it is typed and offers the existing card. Cards come from `searchClients` / `addClient` (`maestro_search_clients`, `maestro_add_client_card`); a card may have no number, and every visit of such a client is messaged to the owner. The owner, the administrator and the partner see numbers whole (`seesFullPhones`: they call clients to confirm bookings); a master gets them masked by `maskPhoneForStaff` (`+998 90 *** ** 22`), also in his `load`. Only the owner reads a card with its history (`getClient`), corrects its name and number (`updateClient` → `maestro_update_client_card`, the name also rewritten into its visits and bookings) and merges two cards of one person (`mergeClients` → `maestro_merge_clients`). A site booking never renames an existing card (`maestro_upsert_client` keeps the name for source `web`); in the bot a known number has «Другой номер» beside it. Staff do not book clients on the site from their own phone (2026-10-19, migration `20261019100000_staff_site_bookings.sql`): `maestro_confirm_booking` refuses an active `app_users` Telegram account with `staff_account` and gives the time back at once, and the bot tells him to pass the client to the administrator (`staffAccount`). A visit counts unless `maestro_sale_is_rejected(status, comment)`.
- Language (2026-10-16, migration `20261016200000_user_language.sql`): each person picks Russian or Uzbek (Latin) with the RU/UZ button in the header; it is kept in `app_users.lang` (`setLanguage`, allowed to every role) and on the phone. The screens stay written in Russian: `src/i18n/index.js` translates what React puts on the page (text and placeholder/aria-label/title) with a MutationObserver, from `src/i18n/uz.js` — exact PHRASES, TEMPLATES with {0} slots, WORDS as a last resort; a text it cannot translate whole stays Russian, so names and data are never half-translated. Services read in Uzbek from `booking_services.name_uz`. A new screen text needs its Uzbek in `uz.js`. The bot writes a master in his language (`masterText`).
- Payouts (2026-10-16, migration `20261016180000_payouts.sql`, `src/utils/payouts.js`): a week runs Monday to Sunday and is paid on Sunday night. Owed for a week = the master's commission on its counted visits − its fines − the advances he took that week (`master_advances`) − what was already paid for it (`master_payouts`, a snapshot of what the owner saw). An advance is his own money paid early: never a fine, never salon income, it changes no earnings or profit. Команда → «Выплаты» (`PayoutsView`): the owner gives advances and marks a week paid, the partner reads; a master sees his week in «Рабочий день» (`MyWeek`). Period figures that used to read «к выплате» now read «заработал». The one old «штраф-аванс» left (Салим, 150 000, 15.10) is moved into advances by the release (`docs/release-2026-10/salim_advance.sql`); from then on an advance is never booked as a fine. Advances and payouts are owner-only actions.
- Discipline (2026-10-16, migration `20261016140000_auto_fines.sql`): a late arrival is fined automatically in `setAttendance` (`maestro_settle_late_fine`, threshold `maestro_late_threshold` = the app's `shiftStartFor`); the owner correcting it to on time, or deleting the arrival, takes the fine back. At 18:00 Tashkent (pg_cron `maestro-no-mark-fines`) `maestro_fine_missing_marks` fines every active master due that day with neither an arrival nor a day off; a day off set later drops it (`maestro_drop_auto_fine`, journalled with the actor). Amounts are `settings.late_fine_amount` / `no_mark_fine_amount` (100 000), from `auto_fines_since`; `fines.auto` marks them, one per master and day. A master with a booking that has ended and is still open records no visit that does not close a booking (`maestro_unclosed_bookings`, error `bookings_to_close`); the booking-bot reminds him a quarter of an hour after the booking's end, never while the client may still be in the chair (`maestro_claim_master_reminders`, «Не пришёл» button `n:<id>`); the owner and the partner see «Не закрыто» per master in «Записи». Bookings before `settings.booking_control_since` are left out of all three. `addBooking` messages the booking's master at once (`masterBookingNotice`, number masked); so do a cancellation by the desk (`setAppointmentOutcome`) and a move (`moveBooking` → `maestro_move_appointment`, free time by `maestro_booking_slots(..., p_except_appointment)`; a new master gets «Новая запись», the old one «передана другому мастеру»). Site bookings reach him from the booking-bot, also masked.
- Duty (2026-10-26, migration `20261027100000_duty.sql`, `src/utils/duty.js`, texts in `supabase/functions/_shared/duty.js`): one master a day keeps the salon clean. The owner sets the week in Команда → «Дежурство» (`DutyView`, `setDutyRoster` → `maestro_set_duty_roster`, days from today on; a change cancels that day's open requests). From the duty master's own shift start (his schedule version for that weekday, 10:00–22:00 if none) the day is cut into 2-hour windows (`maestro_duty_windows`; a rest under an hour joins the last). In each window he sends one photo from his «Дежурство» tab (`MasterDutyView`/`MyDuty`, `addDutyPhoto` → `maestro_add_duty_photo`, file in the private `duty-photos` bucket); refused outside a window, twice for a window, when the phone dates it over 15 minutes back, and when it repeats one of the last 30 days (same sha256, or a 256-bit dHash at most 6 bits off). Every 5 minutes pg_cron `maestro-duty-fines` (`maestro_settle_duty_fines`) fines each ended window without a photo once (`fines.auto = 'duty'`, `duty_window` = its start, `settings.duty_fine_amount` 50 000), from `settings.duty_since` (2026-11-02; before it a trial week, no fines) and only to a master who held the day before the window ended (`duty_roster.updated_at`). A day off does not excuse him: he asks another master (`askDutySwap`), who accepts in the app or with the bot's `d:<id>:1` (`maestro_answer_duty_swap`: the roster changes, `source = 'swap'`). `maestro-duty-notices` calls booking-bot `{"action":"duty"}`: the evening notice at 20:00, a reminder 20 minutes before a window ends with no photo, the fine, the owner's Sunday 18:00 reminder for an unset week; photos older than 30 days are deleted there. The owner and the partner see a day's photos (`dutyDay`, signed links); everyone sees today's duty (`DutyTodayCard`; `load` carries `duty` from `maestro_duty_state`).
- Duty zones (2026-10-27, migration `20261027120000_duty_zones.sql`, supersedes the one photo per window above): a window is done when every zone of `duty_zones` (kitchen, bar, toilet; names and checklists ru/uz) has an accepted send. A send is one zone in 1–3 photos judged together (`addDutyPhoto` with `zone` + `photos[]`; `maestro_duty_photo_problem` checks it first, `maestro_add_duty_attempt` records it in `duty_attempts`, its files in `duty_photos.attempt_id`). Photos go only in a window's first hour (`settings.duty_photo_minutes` 60, `maestro_duty_photo_until`, error `duty_photo_closed`): the window 14:00–16:00 takes photos 14:00–15:00, and the fine, the reminder 20 minutes before and the screens' labels all follow that hour. The api sends each zone to `duty-photo-check`, which runs in the Maestro AI project (`kzqsqjfoctyyovtvykcc`, where `ANTHROPIC_API_KEY` lives; deploy there with `--no-verify-jwt`), reached by `DUTY_CHECK_URL` with the shared `DUTY_CHECK_SECRET` header; a zone not shown or dirty is refused with a reason in both languages (`status = 'rejected'`, kept for the owner and the partner in `dutyDay`) and the master retakes it. With the check unset, unreachable or undecided the zone counts. One fine per window with any zone missing. A repeat is a counted picture only (2026-10-28, migration `20261028100000_duty_repeat_counted_only.sql`): a refused one may be retaken from the same spot or sent to the right zone, and is looked at again. In `DutyDayPhotos` a refusal whose zone was counted after all reads «Переснято» in grey; red «Не принято» is left for zones still missing. The bins are zones of their own (2026-10-28, migration `20261028140000_duty_bins.sql`): `kitchen_bin` «Урна на кухне» and `toilet_bin` «Урна в туалете», shot with the lid open and refused by the check only when full or overflowing (the bin paragraph of `DUTY_CHECK_SYSTEM`); the kitchen's checklist no longer names its bin. A zone added later carries `duty_zones.counts_from` and is owed only by windows that begin at or after it (`maestro_duty_zones_missing`; `zonesFor` in `src/utils/duty.js` on the screens), so earlier windows keep the zones they had.
- New sales submitted by masters require owner approval. Only rows explicitly marked with `comment = owner_approval_required` are treated as new pending approvals; legacy pending rows must keep their historical calculation behavior unless a separate audited migration is approved.
- Pending or rejected owner-approval sales must not affect revenue, client, payout, or profit totals. Never bulk-update historical sale amounts or statuses while implementing this workflow.
- Data loads from Supabase must be paginated; a large `.limit(...)` does not guarantee that PostgREST will return more than the configured server maximum.
- Investment balances for Murod and Jamshid use all expense history, matching the legacy HTML. Period filters apply to the finance report and expense list, not to lifetime investment balances.
- For UI-only work, do not change formulas, action payloads, Supabase writes, or stored values. Financial sums must remain byte-for-byte behaviorally equivalent unless the user explicitly asks for a calculation change.
- Current known public tables include:
  - `app_users`
  - `masters`
  - `sales`
  - `attendance`
  - `fines`
  - `expenses`
  - `debts`
  - `debt_payments`
  - `settings`
- Current known local Edge Function:
  - `supabase/functions/api`
  - `supabase/functions/agents-report`
  - `supabase/functions/agents-content`
  - `supabase/functions/marketing-digest` — the 10:00 Tashkent new-client message for the marketing Telegram group. Called by the pg_cron job `maestro-marketing-digest` (`0 5 * * *` UTC) through pg_net with the `x-marketing-digest-secret` header; the secret is `MARKETING_DIGEST_SECRET` in function secrets and `marketing_digest_secret` in Vault, the target chat is `MARKETING_DIGEST_CHAT_ID`, and it sends through the same `BOT_TOKEN` (`@Maestro_uzbot`) as Telegram login. It only reads `sales` and only ever posts to that one chat; the bot has no webhook and reacts to nothing.
- Current verified remote Edge Functions (2026-07-13):
  - `api`
  - `telegram-auth`
  - `agents-report`
  - `agents-content`
- Current known remote Edge Function list may differ from local files. Always compare before deploying or editing functions.
- `telegram-auth` may intentionally use `verify_jwt = false` only because it must verify Telegram `initData` itself. Do not disable JWT verification for other functions without a clear security reason.
- Critical security note: on 2026-07-13 RLS was verified enabled on every current public Maestro table, with no `pg_policies` rows. The browser does not query these tables directly; the server-side `api` Edge Function uses its server secret and is the current data gateway. Do not disable RLS, add broad policies, or change grants without an audited migration and end-to-end authorization tests.
- Never place `SUPABASE_SERVICE_ROLE_KEY`, Telegram bot tokens, or other server secrets in frontend code, Vercel client env vars, or committed files.

## Verification

Use the smallest verification that proves the change:

- For frontend changes: `npm run build`.
- For local UI behavior: run the app or preview build and inspect the page.
- For deployed UI behavior: inspect the Vercel deployment URL.
- For Supabase Edge Functions: compare local files with remote function state before deployment, then verify the function exists after deployment.
- For auth changes: test both allowed and denied paths when possible.

## Final Response Requirements

At the end of every feature or fix, explain in detail:

- What was changed.
- Which files were changed.
- What commands or checks were run.
- Whether the change was committed and pushed to GitHub.
- Whether Vercel received and deployed the update.
- What Supabase tables, functions, auth rules, or env vars were checked.
- Where the implementation could be wrong or fragile.
- Exactly where the user should look first if something behaves incorrectly.

Be direct about uncertainty. If a check was not possible, say why.
