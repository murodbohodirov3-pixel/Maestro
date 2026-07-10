import { getAppUserByTelegramId } from './api.js';

export function isDevLoginEnabled() {
  return import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_LOGIN === 'true';
}

export function getTelegramInitData() {
  return window.Telegram?.WebApp?.initData || '';
}

async function loadActiveUserByTelegramId(telegramId) {
  if (!telegramId) return null;

  const user = await getAppUserByTelegramId(telegramId);
  if (!user || !user.active) return null;

  return user;
}

export async function loadUserFromVerifiedTelegram() {
  const initData = getTelegramInitData();
  if (!initData) return null;

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl) {
    throw new Error('Supabase URL не настроен.');
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/telegram-auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(publishableKey ? { apikey: publishableKey } : {}),
    },
    body: JSON.stringify({ initData }),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    throw new Error(result?.error || 'Не удалось проверить Telegram вход.');
  }

  return result.user;
}

export function getDevTelegramId() {
  try {
    const stored = localStorage.getItem('tgAuth');
    if (!stored) return null;

    const parsed = JSON.parse(stored);
    return parsed.telegram_id || parsed.id || null;
  } catch {
    return null;
  }
}

export async function loadUserFromDevLogin() {
  if (!isDevLoginEnabled()) return null;

  const telegramId = getDevTelegramId();
  if (!telegramId) return null;

  const user = await loadActiveUserByTelegramId(telegramId);
  if (!user) return null;

  if (user.role !== 'owner') {
    throw new Error('Dev вход разрешён только owner. Откройте приложение через Telegram.');
  }

  return user;
}

export async function loadCurrentUser() {
  if (getTelegramInitData()) {
    return loadUserFromVerifiedTelegram();
  }

  return loadUserFromDevLogin();
}

export function saveTestTelegramId(telegramId) {
  const value = String(telegramId || '').trim();

  if (!value) {
    localStorage.removeItem('tgAuth');
    return;
  }

  localStorage.setItem('tgAuth', JSON.stringify({ telegram_id: value }));
}
