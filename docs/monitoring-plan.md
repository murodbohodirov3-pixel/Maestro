# Production error monitoring plan

Status: implemented and activated in production on 2026-07-22 after the
fail-closed sentinel suite passed. The environment-variable inventory below is
the operational reference for rotation and recovery.

## Recommendation

Use two Sentry projects in one organization:

- `maestro-frontend` for the React/Vite browser app.
- `maestro-edge` for production Supabase Edge Functions.

Supabase's built-in invocation and runtime logs remain the first operational
fallback. Sentry adds browser error visibility, grouping, alerts, release
tracking, and readable stack traces across both runtimes.

## Required environment variables

### Vercel production and preview

- `VITE_SENTRY_DSN`: public browser DSN for `maestro-frontend`. A DSN is designed
  to be shipped to the browser; it is not an administrative token.
- `VITE_SENTRY_ENVIRONMENT`: `production` or `preview`.
- `SENTRY_AUTH_TOKEN`: secret organization token used only during builds to
  upload source maps. Never expose it with a `VITE_` prefix.
- `SENTRY_ORG`: Sentry organization slug used by the Vite build plugin.
- `SENTRY_PROJECT`: `maestro-frontend`, used by the Vite build plugin.

### Supabase production project `ivowbhraaistxvoymxpf`

- `SENTRY_DSN`: secret DSN for `maestro-edge`.
- `SENTRY_ENVIRONMENT`: `production`.
- `SENTRY_TRACES_SAMPLE_RATE`: initial value `0` for error-only rollout; tracing
  can be enabled later after reviewing volume and privacy.

## Implementation sequence after approval

1. Create the two Sentry projects and configure owner alert recipients.
2. Add `@sentry/react` initialization in `src/main.jsx` and a top-level error
   boundary. Do not structurally refactor `src/App.jsx`.
3. Add `@sentry/vite-plugin` after the existing Vite plugin, generate hidden
   source maps, upload them with `SENTRY_AUTH_TOKEN`, and remove `.map` files
   from the published artifact after upload.
4. Add one shared Deno-compatible reporter under
   `supabase/functions/_shared/` and integrate it incrementally into the live
   functions only after comparing local and remote versions.
5. Keep existing `console.error` output so Supabase Logs remains usable if
   Sentry is unavailable. Flush captured Edge Function errors before the
   request finishes, within a short timeout.
6. Redact authorization headers, Telegram `initData`, OAuth codes, bot tokens,
   phone numbers, request bodies, appointment notes, financial row contents,
   and Supabase secrets. Allowed tags are limited to function/action name,
   HTTP status, app release, role class, and a non-secret request identifier.
7. Verify with synthetic exceptions in preview/test first, confirm source-map
   symbolication and redaction, then enable production DSNs and remove the test
   trigger.

## Mandatory PII filter before SDK installation

Both the frontend and Edge Function initializers must use the same fail-closed
filter through `beforeSend` and `beforeSendTransaction`. Do not enable either
DSN until preview events prove that this filter runs. The filter intentionally
trades some diagnostic detail for privacy:

- discard the complete request body, headers, cookies, query string, and URL
  query parameters;
- discard Sentry user, arbitrary contexts, and extra data;
- discard breadcrumb messages and data;
- discard exception messages and stack-frame local variables;
- discard span descriptions and span data;
- allow only controlled operational tags. In particular, `phone`,
  `client_phone`, `marketing_consent`, names, Telegram identifiers, notes,
  tokens, and any other PII fields are never allowlisted.

The shared implementation is
`supabase/functions/_shared/sentryScrub.js`. It uses an explicit top-level
allowlist rather than spreading the incoming event. Allowed tag values are
also validated: function and action names come from enumerated contracts,
roles come from the application role set, HTTP status is bounded, request IDs
must be UUIDs, and releases must be commit-like identifiers.

The frontend and Deno initializers both call this exact module from
`beforeSend` and `beforeSendTransaction`, with `sendDefaultPii: false`.

Preview acceptance must include synthetic events containing a phone number and
`marketing_consent` in every relevant carrier: breadcrumb message/data,
request body/headers/query, exception message/frame vars, contexts, extra,
tags, and span data. Search the raw Sentry event JSON for those sentinel values;
production enablement is blocked if any survives.

The automated acceptance test is `test/sentry-scrub.test.js`. Run it through
`npm test`; it prints the raw scrubbed event JSON and fails if any of the four
sentinel values survives.

## Acceptance checks

- Frontend exception appears in `maestro-frontend` with a readable source file
  and no sensitive payload.
- Edge Function exception appears in `maestro-edge` and also in Supabase Logs.
- Production build contains no `SENTRY_AUTH_TOKEN`; only the browser DSN is
  public.
- Disabling either DSN does not break normal application or Edge Function
  behavior.

References:

- https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/vite/
- https://supabase.com/docs/guides/functions/logging
- https://supabase.com/docs/guides/functions/error-handling
