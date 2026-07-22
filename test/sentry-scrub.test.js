import assert from 'node:assert/strict';
import test from 'node:test';
import { scrubSentryEvent } from '../supabase/functions/_shared/sentryScrub.js';

const SENTINELS = [
  '+998901234567',
  'SENTRY_SENTINEL_NAME_X9',
  'marketing_consent=SENTRY_SENTINEL_CONSENT_X9',
  'telegram_id=9988776655',
];

const secret = SENTINELS.join('|');

test('scrubSentryEvent removes sentinel PII from every supported carrier', () => {
  const event = {
    event_id: '0123456789abcdef0123456789abcdef',
    timestamp: 1784717228.207,
    platform: 'javascript',
    level: 'error',
    environment: 'production',
    release: 'maestro@da540ddd22193f69259e5bd98a500a241cb826a0',
    message: secret,
    unknown_top_level: secret,
    tags: {
      function: 'api',
      action: 'load',
      http_status: '500',
      role_class: 'owner',
      request_id: '123e4567-e89b-42d3-a456-426614174000',
      phone: SENTINELS[0],
      client_name: SENTINELS[1],
      marketing_consent: SENTINELS[2],
      telegram_id: SENTINELS[3],
    },
    request: {
      method: 'POST',
      url: `https://example.test/api/${SENTINELS[1]}?phone=${SENTINELS[0]}`,
      data: { body: secret },
      headers: { authorization: secret, 'x-client-name': SENTINELS[1] },
      cookies: { session: secret },
      query_string: `telegram=${SENTINELS[3]}`,
      env: { REMOTE_ADDR: secret },
    },
    user: { id: SENTINELS[3], username: SENTINELS[1], ip_address: SENTINELS[0] },
    contexts: { client: { phone: SENTINELS[0], consent: SENTINELS[2] } },
    extra: { client_name: SENTINELS[1], telegram_id: SENTINELS[3] },
    breadcrumbs: [{
      type: 'http',
      category: secret,
      level: 'info',
      timestamp: 1784717228.1,
      message: secret,
      data: { url: secret, request_body: secret },
    }],
    exception: {
      values: [{
        type: secret,
        value: secret,
        mechanism: { type: secret, handled: false, data: { token: secret } },
        stacktrace: {
          frames: [{
            filename: `/private/${SENTINELS[1]}/index.ts`,
            abs_path: `https://example.test/assets/app.js?telegram=${SENTINELS[3]}`,
            function: secret,
            lineno: 42,
            colno: 7,
            in_app: true,
            vars: { phone: SENTINELS[0] },
            pre_context: [secret],
            context_line: secret,
            post_context: [secret],
          }],
        },
      }],
    },
    spans: [{
      trace_id: '0123456789abcdef0123456789abcdef',
      span_id: '0123456789abcdef',
      parent_span_id: 'fedcba9876543210',
      start_timestamp: 1784717228.1,
      timestamp: 1784717228.2,
      op: secret,
      description: secret,
      data: { phone: SENTINELS[0], consent: SENTINELS[2] },
      tags: { telegram_id: SENTINELS[3] },
    }],
    debug_meta: {
      images: [{
        type: 'sourcemap',
        debug_id: '123e4567-e89b-42d3-a456-426614174000',
        code_file: `https://example.test/assets/app.js?name=${SENTINELS[1]}`,
      }],
    },
  };

  const scrubbed = scrubSentryEvent(event);
  const rawJson = JSON.stringify(scrubbed, null, 2);

  console.log('\nRAW_SCRUBBED_SENTRY_EVENT_JSON\n' + rawJson);

  for (const sentinel of SENTINELS) {
    assert.equal(rawJson.includes(sentinel), false, `sentinel leaked: ${sentinel}`);
  }
  assert.deepEqual(scrubbed.tags, {
    function: 'api',
    action: 'load',
    http_status: '500',
    role_class: 'owner',
    request_id: '123e4567-e89b-42d3-a456-426614174000',
  });
  assert.deepEqual(scrubbed.request, { method: 'POST' });
});

