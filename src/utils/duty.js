// Дежурный по чистоте (owner's decisions of 2026-10-26): what the screens
// work out from the server's duty state (maestro_duty_state).

export function addDaysIso(day, days) {
  const parsed = new Date(`${day}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function mondayOf(day) {
  const parsed = new Date(`${day}T12:00:00Z`);
  return addDaysIso(day, -((parsed.getUTCDay() + 6) % 7));
}

export function weekDays(monday) {
  return Array.from({ length: 7 }, (_, index) => addDaysIso(monday, index));
}

export function rosterOn(duty, day) {
  return (duty?.roster || []).find((row) => String(row.day) === String(day)) || null;
}

export function dutyMasterName(duty, masterId) {
  const master = (duty?.masters || []).find((item) => String(item.id) === String(masterId));
  return master?.name || '';
}

export function worksOn(duty, day, masterId) {
  return (duty?.working?.[day] || []).some((id) => String(id) === String(masterId));
}

// When a window's photos are due: its photo hour (owner's decision of
// 2026-10-26: the first hour of each window), or the window as a whole.
export function photoUntil(window) {
  return window?.photo_until || window?.ends_at;
}

// A window as the screen says it, at a moment: done (a photo), fined, open
// now, missed (its photo hour over with no photo, the fine on its way) or later.
export function windowStatus(window, nowMs = Date.now()) {
  if (window?.photo_at) return 'done';
  if (window?.fined) return 'fined';
  const starts = new Date(window?.starts_at).getTime();
  const ends = new Date(photoUntil(window)).getTime();
  if (nowMs >= ends) return 'missed';
  if (nowMs >= starts) return 'open';
  return 'later';
}

export function openWindow(windows = [], nowMs = Date.now()) {
  return windows.find((window) => windowStatus(window, nowMs) === 'open') || null;
}

// The window whose photo hour the clock is in, photo or not.
export function currentWindow(windows = [], nowMs = Date.now()) {
  return windows.find((window) => (
    nowMs >= new Date(window.starts_at).getTime() && nowMs < new Date(photoUntil(window)).getTime()
  )) || null;
}

export function nextWindow(windows = [], nowMs = Date.now()) {
  return windows.find((window) => new Date(window.starts_at).getTime() > nowMs) || null;
}

export function windowsDone(windows = []) {
  return windows.filter((window) => window.photo_at).length;
}

// The zones a window owes: a zone added later (`counts_from`, the bins of
// 2026-10-28) is not owed by windows that began before it, as in
// maestro_duty_zones_missing.
export function zonesFor(zones = [], window) {
  if (!window) return zones;
  const starts = new Date(window.starts_at).getTime();
  return zones.filter((zone) => !zone.counts_from || new Date(zone.counts_from).getTime() <= starts);
}

// Whom a master may ask to take his day: every other active master, those who
// work that day first, each marked whether he works it.
export function swapCandidates(duty, day, selfId) {
  return (duty?.masters || [])
    .filter((master) => String(master.id) !== String(selfId))
    .map((master) => ({ ...master, works: worksOn(duty, day, master.id) }))
    .sort((left, right) => Number(right.works) - Number(left.works) || String(left.name).localeCompare(String(right.name), 'ru'));
}

const SWAP_ANSWER_MS = 60 * 60 * 1000;

// A request is open until the day's duty begins, and an hour at most.
export function swapStillOpen(duty, swap, nowMs = Date.now()) {
  if (swap?.status !== 'pending') return false;
  // Unanswered for an hour, it closes by itself (owner's decision of 2026-11-01).
  if (swap.created_at && nowMs >= new Date(swap.created_at).getTime() + SWAP_ANSWER_MS) return false;
  const row = rosterOn(duty, swap.day);
  if (!row || String(row.master_id) !== String(swap.from_master_id)) return false;
  return !row.starts_at || nowMs < new Date(row.starts_at).getTime();
}

// A master's own duty: the days of the roster that are his from today on,
// what others asked him, what he asked, and the answers of the last days.
export function myDuty(duty, masterId, today, nowMs = Date.now()) {
  const mine = (id) => String(id) === String(masterId);
  const swaps = duty?.swaps || [];
  return {
    days: (duty?.roster || []).filter((row) => mine(row.master_id) && String(row.day) >= String(today)),
    incoming: swaps.filter((swap) => mine(swap.to_master_id) && swapStillOpen(duty, swap, nowMs)),
    outgoing: swaps.filter((swap) => mine(swap.from_master_id) && swapStillOpen(duty, swap, nowMs)),
    answered: swaps.filter((swap) => mine(swap.from_master_id) && ['accepted', 'declined'].includes(swap.status)),
  };
}

// What waits for a master on his «Дежурство» tab, for its badge: each
// request to take a day over, and the photo of the window he is in.
export function masterDutyAttention(duty, masterId, today, nowMs = Date.now()) {
  if (!duty || masterId == null) return 0;
  const mine = myDuty(duty, masterId, today, nowMs);
  const onDuty = String(rosterOn(duty, today)?.master_id ?? '') === String(masterId);
  const current = onDuty ? currentWindow(duty.windows || [], nowMs) : null;
  return mine.incoming.length + (current && !current.photo_at ? 1 : 0);
}

// The owner's week as he edits it: each day's master id, or '' for nobody.
export function rosterDraft(duty, monday) {
  return Object.fromEntries(weekDays(monday).map((day) => [day, String(rosterOn(duty, day)?.master_id ?? '')]));
}

export function rosterChanges(duty, draft) {
  return Object.entries(draft)
    .filter(([day, masterId]) => String(rosterOn(duty, day)?.master_id ?? '') !== String(masterId))
    .map(([day, masterId]) => ({ day, master_id: masterId ? Number(masterId) : null }));
}

// The picture's fingerprint lives with the server's code, which computes it
// from the photo it receives (supabase/functions/_shared/duty.js).
export { differenceHash, greyFromRgba, HASH_HEIGHT, HASH_WIDTH, hashDistance } from '../../supabase/functions/_shared/duty.js';
