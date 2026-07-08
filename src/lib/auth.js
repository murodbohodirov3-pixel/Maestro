import { getAppUserByTelegramId } from './api.js';

function getTelegramWebAppUserId() {
  return window.Telegram?.WebApp?.initDataUnsafe?.user?.id || null;
}

function getStoredTelegramId() {
  try {
    const stored = localStorage.getItem('tgAuth');
    if (!stored) return null;

    const parsed = JSON.parse(stored);
    return parsed.telegram_id || parsed.id || null;
  } catch {
    return null;
  }
}

export function getTelegramId() {
  return getTelegramWebAppUserId() || getStoredTelegramId();
}

export async function loadCurrentUser() {
  const telegramId = getTelegramId();
  if (!telegramId) return null;

  const user = await getAppUserByTelegramId(telegramId);
  if (!user || !user.active) return null;

  return user;
}

export function saveTestTelegramId(telegramId) {
  const value = String(telegramId || '').trim();

  if (!value) {
    localStorage.removeItem('tgAuth');
    return;
  }

  localStorage.setItem('tgAuth', JSON.stringify({ telegram_id: value }));
}
