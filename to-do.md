# Maestro Restore TODO

## Active

- [ ] Authenticated manual check: add one master payment and compare owner/finance screens.

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
