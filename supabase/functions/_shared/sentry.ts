import * as Sentry from 'npm:@sentry/deno@10.67.0';
import { scrubSentryEvent } from './sentryScrub.js';

const dsn = String(Deno.env.get('SENTRY_DSN') || '').trim();
const environment = String(Deno.env.get('SENTRY_ENVIRONMENT') || 'production').trim();
const parsedSampleRate = Number(Deno.env.get('SENTRY_TRACES_SAMPLE_RATE') || '0');
const tracesSampleRate = Number.isFinite(parsedSampleRate)
  ? Math.min(Math.max(parsedSampleRate, 0), 1)
  : 0;

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    sendDefaultPii: false,
    tracesSampleRate,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
    beforeSendTransaction(event) {
      return scrubSentryEvent(event);
    },
  });
}

export async function captureEdgeException(
  error: unknown,
  tags: Record<string, string | number | undefined>,
) {
  if (!dsn) return false;

  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) {
      if (value !== undefined) scope.setTag(key, String(value));
    }
    Sentry.captureException(error);
  });

  return await Sentry.flush(1500);
}

