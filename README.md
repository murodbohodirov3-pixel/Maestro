# Maestro Barberia

React + Vite frontend for Maestro Barberia. The app uses the existing Supabase
tables and keeps legacy fields for compatibility with the old HTML prototype.

The active runtime is `src/main.jsx` -> `src/App.jsx`. Frontend data operations
use `src/lib/legacyApi.js` and the Supabase `api` Edge Function; the browser must
not perform direct table CRUD.

## Requirements

- Node.js 18+
- npm
- Supabase project with existing Maestro tables

## Environment

Create `.env` from `.env.example`:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
```

Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are used by the
frontend. Do not put a Supabase `service_role` key in this project.

## Install

```bash
npm install
```

## Run Locally

```bash
npm run dev
```

Open the local Vite URL shown in the terminal. For local testing without
Telegram WebApp, enter a test `telegram_id` on the "Нет доступа" screen. It is
saved to `localStorage.tgAuth`.

## Build

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Deploy to Vercel

1. Import the repository in Vercel.
2. Set framework preset to Vite.
3. Add environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
4. Build command: `npm run build`
5. Output directory: `dist`

## Important Security Note

RLS is enabled on the production public tables. The browser must not access
operational tables directly: the `api` Edge Function is the only data gateway
and enforces application authorization with server-side credentials. The
matching baseline is committed in
`supabase/migrations/20260722100917_enable_core_operational_rls.sql`; it
deliberately creates no browser-facing policies.

Do not add broad `anon` or `authenticated` policies, disable RLS, or expose a
service-role key in the frontend.

Do not change the Supabase schema or delete legacy columns without a separate
approved migration plan.
