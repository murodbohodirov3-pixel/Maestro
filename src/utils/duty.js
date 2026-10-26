// Дежурный по чистоте (owner's decisions of 2026-10-26): what the screens
// work out from the server's duty state (maestro_duty_state), and the
// fingerprint of a photo that lets the server refuse the same picture twice.

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

// A window as the screen says it, at a moment: done (a photo), fined, open
// now, missed (ended with no photo, the fine still on its way) or later.
export function windowStatus(window, nowMs = Date.now()) {
  if (window?.photo_at) return 'done';
  if (window?.fined) return 'fined';
  const starts = new Date(window?.starts_at).getTime();
  const ends = new Date(window?.ends_at).getTime();
  if (nowMs >= ends) return 'missed';
  if (nowMs >= starts) return 'open';
  return 'later';
}

export function openWindow(windows = [], nowMs = Date.now()) {
  return windows.find((window) => windowStatus(window, nowMs) === 'open') || null;
}

// The window the clock is in, photo or not.
export function currentWindow(windows = [], nowMs = Date.now()) {
  return windows.find((window) => (
    nowMs >= new Date(window.starts_at).getTime() && nowMs < new Date(window.ends_at).getTime()
  )) || null;
}

export function nextWindow(windows = [], nowMs = Date.now()) {
  return windows.find((window) => new Date(window.starts_at).getTime() > nowMs) || null;
}

export function windowsDone(windows = []) {
  return windows.filter((window) => window.photo_at).length;
}

// Whom a master may ask to take his day: every other active master, those who
// work that day first, each marked whether he works it.
export function swapCandidates(duty, day, selfId) {
  return (duty?.masters || [])
    .filter((master) => String(master.id) !== String(selfId))
    .map((master) => ({ ...master, works: worksOn(duty, day, master.id) }))
    .sort((left, right) => Number(right.works) - Number(left.works) || String(left.name).localeCompare(String(right.name), 'ru'));
}

// A request is open until the day's duty begins.
export function swapStillOpen(duty, swap, nowMs = Date.now()) {
  if (swap?.status !== 'pending') return false;
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

// The picture's fingerprint: a difference hash on a 17×16 grey copy, one bit
// for each pair of neighbours in a row, 256 bits as 64 hex digits. The same
// file gives the same hash, a copy saved again a few bits off; the server
// refuses within 6 bits, strict enough that a new shot of the same corner
// is not mistaken for an old one.
export const HASH_WIDTH = 17;
export const HASH_HEIGHT = 16;

export function greyFromRgba(rgba, width = HASH_WIDTH, height = HASH_HEIGHT) {
  const grey = new Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    grey[index] = 0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2];
  }
  return grey;
}

export function differenceHash(grey, width = HASH_WIDTH, height = HASH_HEIGHT) {
  let bits = '';
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      bits += grey[y * width + x] < grey[y * width + x + 1] ? '1' : '0';
    }
  }
  let hex = '';
  for (let index = 0; index < bits.length; index += 4) {
    hex += parseInt(bits.slice(index, index + 4), 2).toString(16);
  }
  return hex;
}

export function hashDistance(left, right) {
  let distance = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    let diff = parseInt(left[index], 16) ^ parseInt(right[index], 16);
    while (diff) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}
