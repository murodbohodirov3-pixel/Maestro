const TG_AUTH_KEY = 'tgAuth';

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
  return !hasTelegramMiniAppUser() && !readWidgetAuth();
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
      action,
      payload,
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result?.error || `HTTP ${response.status}`);
  }

  return result;
}
