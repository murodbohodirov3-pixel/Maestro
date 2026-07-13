# Maestro AI current system map

Verified on 2026-07-13. This document separates live behavior from code that merely exists locally.

## Production systems

### Maestro staff application

- Production URL: `https://maestro-pied-two.vercel.app/`.
- Vercel project: `maestro` (`prj_haFEL3H3UE1z8lCnWe5RPppS3jvS`).
- Latest verified production deployment: commit `45c404b`, state `READY`.
- Frontend: React + Vite under `src/`.
- The browser sends authenticated business operations to Supabase Edge Function `api`.
- Telegram login bot referenced by the frontend: `@Maestro_uzbot`.

### Supabase

- Project ref: `ivowbhraaistxvoymxpf`.
- Project status: `ACTIVE_HEALTHY`, Postgres 17, region `ap-southeast-1`.
- Active Edge Functions: `api`, `telegram-auth`, `agents-report`, `agents-content`.
- Remote `api` contains Telegram OAuth, persistent `app_sessions`, and owner-approval logic.
- RLS is enabled on every current public table. No public RLS policies exist. The server-side functions use a server secret to access data.

Current public tables:

- staff/auth: `app_users`, `app_sessions`;
- operations: `masters`, `sales`, `attendance`, `fines`, `settings`;
- finance: `expenses`, `debts`, `debt_payments`;
- owner content workflow: `agent_content_jobs`.

The live database currently has no services catalog, individual customer profiles, appointments, schedule, available slots, cancellations, no-shows, reviews, marketing sources, or customer conversation history.

### Owner Telegram AI team

- Public health URL: `https://maestro-telegram-agents.vercel.app/api/health`.
- Health currently reports Telegram, owner restriction, OpenAI, persistent conversation, Maestro reports, and content jobs configured.
- The webhook rejects an unsigned request with HTTP 401.
- The service is owner-only. It is an analytics/content assistant, not the customer administrator.
- It reads allowlisted aggregated data through `agents-report` and can write only approval-controlled `agent_content_jobs` through `agents-content`.

## Current data and identities

Active masters verified in Supabase:

- Жавохир
- Иброхим
- Жавлон
- Жамолиддин
- Мироншох

Salon settings currently contain shift start `10:10`, a 50-metre attendance radius, and coordinates `41.3512479308835, 69.2895722812834`. OpenStreetMap reverse lookup places the coordinates near `8 Chinobod ko'chasi, Yunusobod`; this is not yet accepted as the customer-facing postal address.

## Boundaries for the customer AI administrator

The first customer-facing agent must be a separate channel and service boundary:

1. Do not reuse `@maestro_ai_team_bot`; it contains private owner analytics.
2. Do not repurpose `@Maestro_uzbot` until its login/OAuth duties and current Telegram webhook ownership are explicitly audited.
3. Do not expose `agents-report` or financial tables to customer conversations.
4. Stage 3 may read only approved business knowledge, active masters, and later a dedicated read-only availability contract.
5. The first booking operation creates a pending request only; it must not call current finance/business write actions.
6. Every customer message, tool call, handoff, and booking request needs durable idempotency and an audit trail.

## Reusable components

- Telegram secret comparison and webhook denial behavior from `services/telegram-agents`.
- OpenAI Responses API tool loop and bounded tool-call execution.
- Server-only secret boundary used by `agents-report`.
- Tashkent timezone helpers and paginated reads.

These components should be extracted or adapted only after the customer data contract is approved. The owner prompts, financial report tools, content commands, and persistent owner conversation must not be shared with customers.

## Stage 2 inputs already known

- Brand name: Maestro Barberia.
- City/timezone: Tashkent, `Asia/Tashkent`.
- Active master names: listed above.
- Approximate coordinates: verified from live settings.
- Supported languages required by the plan: Russian and Uzbek.

## Stage 2 inputs still requiring authoritative confirmation

- customer-facing address and map link;
- public phone, Telegram, and Instagram;
- opening hours by weekday;
- complete service catalog, exact prices, and durations;
- which masters perform which services;
- late, cancellation, refund, discount, and child-service rules;
- payment methods;
- current promotions;
- approved RU/UZ phrases and spelling of business/master names;
- whether a new customer bot should be created or an existing business bot should be audited for reuse.

No production schema or business data was changed during this inspection.
