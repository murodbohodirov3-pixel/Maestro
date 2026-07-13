# Maestro Restore TODO

## Active

- [ ] Authenticated manual check: add one master payment and compare owner/finance screens.
- [ ] Add `AGENTS_REPORT_SECRET` in Supabase; configure and deploy the separate Telegram agents Vercel project with its private environment variables.
- [ ] Create the persistent OpenAI conversation and register the Telegram webhook after deployment.
- [ ] Connect the owner's Higgsfield account through the official MCP flow, then enable credit-spending generation only behind explicit Telegram approval and job-status tracking.

## Completed

- [x] Confirmed break point: `4130f28` replaced working HTML with React/Vite.
- [x] Confirmed remote Supabase function `api` is active and contains legacy actions.
- [x] Confirmed RLS is disabled and must not be enabled without policies.
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
