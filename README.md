# Maestro Barberia

React + Vite frontend for Maestro Barberia. The app uses the existing Supabase
tables and keeps legacy fields for compatibility with the old HTML prototype.

## Requirements

- Node.js 18+
- npm
- Supabase project with existing Maestro tables

## Environment

Create `.env` from `.env.example`:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
VITE_ENABLE_DEV_LOGIN=false
```

Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are used by the
frontend. Do not put a Supabase `service_role` key in this project.

`VITE_ENABLE_DEV_LOGIN` is only for local development and owner testing. Keep it
unset or `false` on Vercel production. Dev login reads `localStorage.tgAuth` and
is restricted to users with the `owner` role. Masters, admins, and finance users
must use Telegram WebApp auth after the `telegram-auth` Edge Function is
added.

## Install

```bash
npm install
```

## Run Locally

```bash
npm run dev
```

Open the local Vite URL shown in the terminal. For local testing without
Telegram WebApp, enter an owner test `telegram_id` on the "Нет доступа" screen.
It is saved to `localStorage.tgAuth`. Dev login does not allow
`master`, `admin`, or `finance` roles.

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
   - `VITE_ENABLE_DEV_LOGIN=false` or leave it unset
4. Build command: `npm run build`
5. Output directory: `dist`

Do not add `TELEGRAM_BOT_TOKEN` or `SUPABASE_SERVICE_ROLE_KEY` to frontend or
Vercel client environment variables. They belong only in Supabase Edge Function
secrets when verified Telegram auth is implemented.

## Telegram Auth Edge Function

Create a Telegram bot in BotFather and connect the deployed Vercel URL as the
Telegram Mini App URL.

Set the bot token only as a Supabase secret:

```bash
supabase secrets set TELEGRAM_BOT_TOKEN=your-telegram-bot-token
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are available to Supabase Edge
Functions in the Supabase environment. Keep `SUPABASE_SERVICE_ROLE_KEY` out of
Vercel and out of frontend `.env` files.

Deploy the function:

```bash
supabase functions deploy telegram-auth
```

The function is configured in `supabase/config.toml` with `verify_jwt = false`
because it is the first authentication endpoint. It validates
`Telegram.WebApp.initData` itself before reading `public.app_users`.

To test:

1. Open the app from Telegram Mini App, not from a normal browser tab.
2. Confirm that Telegram provides `window.Telegram.WebApp.initData`.
3. The frontend sends `initData` to `/functions/v1/telegram-auth`.
4. The function verifies the Telegram hash and `auth_date`.
5. If `app_users.telegram_id` exists and `active = true`, the app logs in.

Invalid or manually edited `initData` should return `401 invalid telegram
signature`. A missing `app_users` row returns `403 user not allowed`.

## Important Security Note

RLS is currently disabled for development. Before production launch, enable RLS
and add Supabase policies for `app_users`, `masters`, `sales`, `attendance`,
`fines`, `expenses`, `debts`, `debt_payments`, and `settings`.

Do not change the Supabase schema or delete legacy columns without a separate
approved migration plan.
