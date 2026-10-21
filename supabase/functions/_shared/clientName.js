// A client's first name and surname, each on its own and both required
// (owner's decision of 2026-10-21): the salon has six clients called Сардор,
// and a master who types only the name records the visit on the wrong one.
// One rule for the app, the api and the booking page's server; the database
// checks the same (maestro_name_part_ok).

export const NAME_PART_MAX = 40;

// Single spaces, no edges. A word typed all in small or all in capital letters
// gets one capital: «sardor KARIMOV» → «Sardor Karimov». Anything else is kept
// as typed.
export function tidyNamePart(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.split(/([ -])/).map((piece) => {
    if (!piece || piece === ' ' || piece === '-') return piece;
    if (piece !== piece.toLowerCase() && piece !== piece.toUpperCase()) return piece;
    const lower = piece.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');
}

// Two letters at least, no digits: «I», «Клиент 2» and a number typed into
// the name are refused.
export function namePartOk(part) {
  return part.length >= 2 && part.length <= NAME_PART_MAX && !/[0-9]/.test(part);
}

// { ok: true, first_name, last_name } or { ok: false, error }.
export function checkClientName(firstName, lastName) {
  const first = tidyNamePart(firstName);
  const last = tidyNamePart(lastName);
  if (!namePartOk(first)) return { ok: false, error: 'invalid_first_name' };
  if (!namePartOk(last)) return { ok: false, error: 'invalid_last_name' };
  return { ok: true, first_name: first, last_name: last };
}

// A surname alone, for a card that has a name and lacks it.
export function checkLastName(lastName) {
  const last = tidyNamePart(lastName);
  return namePartOk(last) ? { ok: true, last_name: last } : { ok: false, error: 'invalid_last_name' };
}
