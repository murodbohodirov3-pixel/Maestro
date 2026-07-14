const TG_AUTH_KEY = 'tgAuth';
const APP_SESSION_KEY = 'maestroSession';
const TG_OAUTH_STATE_KEY = 'telegramOAuthState';
const TG_OAUTH_VERIFIER_KEY = 'telegramOAuthVerifier';
const TELEGRAM_OAUTH_CLIENT_ID = '8865126796';

function getApiUrl() {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

  if (!supabaseUrl) {
    throw new Error('VITE_SUPABASE_URL не настроен.');
  }

  return `${supabaseUrl}/functions/v1/api`;
}

export function getTelegramInitData() {
  return window.Telegram?.WebApp?.initData || '';
}

export function hasTelegramMiniAppUser() {
  return Boolean(window.Telegram?.WebApp?.initDataUnsafe?.user);
}

export function getTelegramFirstName() {
  return window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name || '';
}

export function readWidgetAuth() {
  try {
    const stored = localStorage.getItem(TG_AUTH_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function saveWidgetAuth(auth) {
  localStorage.setItem(TG_AUTH_KEY, JSON.stringify(auth));
}

export function clearWidgetAuth() {
  localStorage.removeItem(TG_AUTH_KEY);
  localStorage.removeItem(APP_SESSION_KEY);
  localStorage.removeItem(TG_OAUTH_STATE_KEY);
  localStorage.removeItem(TG_OAUTH_VERIFIER_KEY);
}

function readSessionToken() {
  return localStorage.getItem(APP_SESSION_KEY) || null;
}

function base64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function getRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

export async function startTelegramOAuthLogin() {
  const state = randomToken();
  const verifier = randomToken(48);
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = getRedirectUri();

  localStorage.setItem(TG_OAUTH_STATE_KEY, state);
  localStorage.setItem(TG_OAUTH_VERIFIER_KEY, verifier);

  const url = new URL('https://oauth.telegram.org/auth');
  url.searchParams.set('client_id', TELEGRAM_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  window.location.assign(url.toString());
}

export async function captureTelegramOAuthCode() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');

  if (!code) return false;

  const state = params.get('state');
  const storedState = localStorage.getItem(TG_OAUTH_STATE_KEY);
  const codeVerifier = localStorage.getItem(TG_OAUTH_VERIFIER_KEY);

  if (!state || !storedState || state !== storedState || !codeVerifier) {
    throw new Error('telegram_oauth_state_mismatch');
  }

  await callLegacyApi('telegramOAuth', {
    code,
    codeVerifier,
    redirectUri: getRedirectUri(),
  });

  localStorage.removeItem(TG_OAUTH_STATE_KEY);
  localStorage.removeItem(TG_OAUTH_VERIFIER_KEY);
  window.history.replaceState(null, '', window.location.origin + window.location.pathname);

  return true;
}

export function captureTelegramRedirectAuth() {
  try {
    const params = new URLSearchParams(window.location.search);

    if (!params.get('hash') || !params.get('id')) return null;

    const auth = {};
    params.forEach((value, key) => {
      auth[key] = value;
    });

    saveWidgetAuth(auth);
    window.history.replaceState(null, '', window.location.origin + window.location.pathname);

    return auth;
  } catch {
    return null;
  }
}

export function needsTelegramLogin() {
  return !hasTelegramMiniAppUser() && !readWidgetAuth() && !readSessionToken();
}

export async function callLegacyApi(action, payload = {}) {
  const response = await fetch(getApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
        ? { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY }
        : {}),
    },
    body: JSON.stringify({
      initData: getTelegramInitData(),
      tgAuth: readWidgetAuth(),
      sessionToken: readSessionToken(),
      action,
      payload,
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) localStorage.removeItem(APP_SESSION_KEY);
    const error = new Error(result?.error || `HTTP ${response.status}`);
    error.details = result;
    throw error;
  }

  if (result?.sessionToken) localStorage.setItem(APP_SESSION_KEY, result.sessionToken);

  return result;
}
