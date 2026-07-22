import * as Sentry from '@sentry/react';
import { scrubSentryEvent } from '../../supabase/functions/_shared/sentryScrub.js';

const dsn = String(import.meta.env.VITE_SENTRY_DSN || '').trim();
const environment = String(
  import.meta.env.VITE_SENTRY_ENVIRONMENT || (import.meta.env.PROD ? 'production' : 'development'),
).trim();
const release = typeof __MAESTRO_RELEASE__ === 'string' ? __MAESTRO_RELEASE__ : '';

export function initSentry() {
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment,
    release: release || undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
    beforeSendTransaction(event) {
      return scrubSentryEvent(event);
    },
  });

  return true;
}

export { Sentry };

