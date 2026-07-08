# Maestro Restore TODO

## Active

- [ ] Verify build, push to GitHub, and confirm Vercel production receives the commit.
- [ ] Smoke test the live app: login gate, legacy layout, role tabs, and data load.

## Completed

- [x] Confirmed break point: `4130f28` replaced working HTML with React/Vite.
- [x] Confirmed remote Supabase function `api` is active and contains legacy actions.
- [x] Confirmed RLS is disabled and must not be enabled without policies.
- [x] Added React legacy shell that loads and mutates data through Edge Function `api`.
- [x] Restored Telegram Mini App / Login Widget auth flow in React.
- [x] Added local source copy for `supabase/functions/api`.
- [x] Replaced automatic broken Telegram widget render with Telegram fallback and BotFather domain guidance.
- [x] Added mobile layout safeguards without changing formulas, API payloads, or database writes.
