// Who may do what, kept apart from the api so it can be tested under Node.
//
// A partner (соучредитель) reads the salon's figures and changes nothing. The
// server is what enforces that; the app only leaves the buttons out.

export const PARTNER_ROLE = 'partner';

// Everything a partner's session may ask the api for. Any other action is
// refused before it reaches a table, including actions added later.
const PARTNER_ACTIONS = new Set(['load']);

export function partnerMayCall(action) {
  return PARTNER_ACTIONS.has(action);
}

// A partner sees how much was spent and when, never on what: an expense reaches
// him without its name, note, quantity or who entered it. The fields kept are
// exactly the ones the totals, the comparisons and the investment balances are
// computed from.
const PARTNER_EXPENSE_FIELDS = ['id', 'date', 'section', 'category', 'amount_uzs', 'usd_rate', 'minus_from'];

export function expenseForPartner(expense) {
  const visible = {};
  for (const field of PARTNER_EXPENSE_FIELDS) {
    if (expense?.[field] !== undefined) visible[field] = expense[field];
  }
  return visible;
}
