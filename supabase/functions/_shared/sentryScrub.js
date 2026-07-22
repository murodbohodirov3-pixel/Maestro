const SAFE_TAG_KEYS = new Set([
  'function',
  'action',
  'http_status',
  'release',
  'role_class',
  'request_id',
]);

const SAFE_FUNCTIONS = new Set([
  'api',
  'telegram-auth',
  'agents-report',
  'agents-content',
  'customer-availability',
  'customer-booking-approval',
  'customer-notifications',
]);

const SAFE_ACTIONS = new Set([
  'telegramOAuth',
  'listAuditEvents',
  'load',
  'addSale',
  'setSaleApproval',
  'delSale',
  'setAttendance',
  'delAttendance',
  'setMasterDayOff',
  'addAppointment',
  'setAppointmentStatus',
  'addFine',
  'delFine',
  'setSettings',
  'addExpense',
  'delExpense',
  'addDebt',
  'addDebtPayment',
  'delDebtPayment',
  'delDebt',
  'setDebtClosed',
  'unknown',
]);

const SAFE_ROLES = new Set([
  'owner',
  'admin',
  'finance',
  'master',
  'unauthenticated',
  'unknown',
]);

const SAFE_LEVELS = new Set(['fatal', 'error', 'warning', 'log', 'info', 'debug']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const SAFE_ENVIRONMENTS = new Set(['production', 'preview', 'development', 'test']);
const SAFE_EXCEPTION_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'AggregateError',
  'UnhandledRejection',
]);
const SAFE_SOURCE_BASENAMES = new Set([
  'index.ts',
  'sentry.ts',
  'sentryScrub.js',
  'main.jsx',
  'App.jsx',
  'legacyApi.js',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const RELEASE_PATTERN = /^(?:maestro@)?[0-9a-f]{7,40}$/i;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeTimestamp(value) {
  if (finiteNumber(value) !== undefined) return value;
  if (typeof value !== 'string') return undefined;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ? value : undefined;
}

function safeRelease(value) {
  return typeof value === 'string' && RELEASE_PATTERN.test(value) ? value : undefined;
}

function safeSourceFile(value) {
  if (typeof value !== 'string') return undefined;
  const withoutQuery = value.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const assetMatch = withoutQuery.match(/\/assets\/([A-Za-z0-9._-]+\.(?:js|mjs|cjs))$/);
  if (assetMatch) return `/assets/${assetMatch[1]}`;
  const basename = withoutQuery.split('/').pop();
  return SAFE_SOURCE_BASENAMES.has(basename) ? basename : undefined;
}

function safeTagValue(key, value) {
  const text = String(value ?? '');
  if (key === 'function') return SAFE_FUNCTIONS.has(text) ? text : undefined;
  if (key === 'action') return SAFE_ACTIONS.has(text) ? text : undefined;
  if (key === 'role_class') return SAFE_ROLES.has(text) ? text : undefined;
  if (key === 'request_id') return UUID_PATTERN.test(text) ? text : undefined;
  if (key === 'release') return safeRelease(text);
  if (key === 'http_status') {
    const status = Number(text);
    return Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : undefined;
  }
  return undefined;
}

function scrubTags(tags) {
  const safe = {};
  for (const [key, value] of Object.entries(tags || {})) {
    if (!SAFE_TAG_KEYS.has(key)) continue;
    const scrubbed = safeTagValue(key, value);
    if (scrubbed !== undefined) safe[key] = scrubbed;
  }
  return safe;
}

function scrubFrame(frame) {
  const safe = {};
  const filename = safeSourceFile(frame?.filename);
  const absPath = safeSourceFile(frame?.abs_path);
  if (filename) safe.filename = filename;
  if (absPath) safe.abs_path = absPath;
  const lineno = finiteNumber(frame?.lineno);
  const colno = finiteNumber(frame?.colno);
  if (lineno !== undefined) safe.lineno = lineno;
  if (colno !== undefined) safe.colno = colno;
  if (typeof frame?.in_app === 'boolean') safe.in_app = frame.in_app;
  return safe;
}

function scrubStacktrace(stacktrace) {
  if (!Array.isArray(stacktrace?.frames)) return undefined;
  return { frames: stacktrace.frames.map(scrubFrame) };
}

function scrubException(exception) {
  if (!Array.isArray(exception?.values)) return undefined;
  return {
    values: exception.values.map((value) => {
      const safe = {
        type: SAFE_EXCEPTION_TYPES.has(value?.type) ? value.type : 'Error',
        value: '[redacted exception message]',
      };
      const stacktrace = scrubStacktrace(value?.stacktrace);
      if (stacktrace) safe.stacktrace = stacktrace;
      if (value?.mechanism) {
        safe.mechanism = {
          handled: typeof value.mechanism.handled === 'boolean' ? value.mechanism.handled : undefined,
        };
      }
      return safe;
    }),
  };
}

function scrubBreadcrumbs(breadcrumbs) {
  if (!Array.isArray(breadcrumbs)) return undefined;
  return breadcrumbs.map((breadcrumb) => ({
    level: SAFE_LEVELS.has(breadcrumb?.level) ? breadcrumb.level : undefined,
    timestamp: safeTimestamp(breadcrumb?.timestamp),
  }));
}

function scrubSpans(spans) {
  if (!Array.isArray(spans)) return undefined;
  return spans.map((span) => ({
    trace_id: EVENT_ID_PATTERN.test(String(span?.trace_id || '')) ? span.trace_id : undefined,
    span_id: /^[0-9a-f]{16}$/i.test(String(span?.span_id || '')) ? span.span_id : undefined,
    parent_span_id: /^[0-9a-f]{16}$/i.test(String(span?.parent_span_id || ''))
      ? span.parent_span_id
      : undefined,
    start_timestamp: finiteNumber(span?.start_timestamp),
    timestamp: finiteNumber(span?.timestamp),
  }));
}

function scrubDebugMeta(debugMeta) {
  if (!Array.isArray(debugMeta?.images)) return undefined;
  return {
    images: debugMeta.images.map((image) => ({
      type: image?.type === 'sourcemap' ? 'sourcemap' : undefined,
      debug_id: UUID_PATTERN.test(String(image?.debug_id || '')) ? image.debug_id : undefined,
      code_file: safeSourceFile(image?.code_file),
    })),
  };
}

export function scrubSentryEvent(event = {}) {
  const safe = {};

  if (EVENT_ID_PATTERN.test(String(event.event_id || ''))) safe.event_id = event.event_id;
  const timestamp = safeTimestamp(event.timestamp);
  if (timestamp !== undefined) safe.timestamp = timestamp;
  if (event.platform === 'javascript') safe.platform = 'javascript';
  if (SAFE_LEVELS.has(event.level)) safe.level = event.level;
  if (SAFE_ENVIRONMENTS.has(event.environment)) safe.environment = event.environment;
  const release = safeRelease(event.release);
  if (release) safe.release = release;
  if (event.message) safe.message = '[redacted error message]';

  safe.tags = scrubTags(event.tags);

  if (event.request) {
    const method = String(event.request.method || '').toUpperCase();
    safe.request = SAFE_METHODS.has(method) ? { method } : {};
  }

  const breadcrumbs = scrubBreadcrumbs(event.breadcrumbs);
  if (breadcrumbs) safe.breadcrumbs = breadcrumbs;
  const exception = scrubException(event.exception);
  if (exception) safe.exception = exception;
  const spans = scrubSpans(event.spans);
  if (spans) safe.spans = spans;
  const debugMeta = scrubDebugMeta(event.debug_meta);
  if (debugMeta) safe.debug_meta = debugMeta;

  return safe;
}
