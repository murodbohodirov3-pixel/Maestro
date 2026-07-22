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
- Business writes should go through `api` actions (`load`, `addSale`, `setSaleApproval`, `delSale`, `setAttendance`, `delAttendance`, `addFine`, `delFine`, `setSettings`, `addExpense`, `delExpense`, `addDebt`, `addDebtPayment`, `delDebtPayment`, `delDebt`, `setDebtClosed`) unless a later approved migration replaces this gateway.
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
