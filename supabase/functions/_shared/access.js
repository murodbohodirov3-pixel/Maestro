// Who may do what, kept apart from the api so it can be tested under Node.
//
// A partner (соучредитель) reads the salon's figures and changes none of them.
// Since 2026-10-16 he also takes bookings that come by phone or Telegram, like
// the owner and the administrator: finds or makes the client's card, books a
// free time, marks a cancellation or a no-show. And he sets the masters' days
// off: a master with neither an arrival nor a day off by 18:00 is fined. The
// server is what enforces this; the app only leaves the other buttons out.

export const PARTNER_ROLE = 'partner';

// Everything a partner's session may ask the api for. Any other action is
// refused before it reaches a table, including actions added later.
const PARTNER_ACTIONS = new Set([
  'load',
  'bookingSlots',
  'addBooking',
  'setAppointmentOutcome',
  'searchClients',
  'addClient',
  'completeClientName',
  'setMasterDayOff',
  'moveBooking',
  'setLanguage',
  'siteStats',
]);

export function partnerMayCall(action) {
  return PARTNER_ACTIONS.has(action);
}

// The administrator (role 'admin') works the front desk. As decided by the
// owner on 2026-10-15 and 16, she sells goods from Склад and keeps the
// bookings: books a client over the phone (finding or making his card), marks
// a no-show or a cancellation. Deliveries, write-offs and every decision are
// the owner's; she sees no revenue, payouts, expenses or purchase prices.
export const ADMIN_ROLE = 'admin';

const ADMIN_ACTIONS = new Set([
  'load',
  'addProductSale',
  'delStockEntry',
  'bookingSlots',
  'addBooking',
  'setAppointmentOutcome',
  'searchClients',
  'addClient',
  'completeClientName',
  'moveBooking',
  'setLanguage',
]);

export function adminMayCall(action) {
  return ADMIN_ACTIONS.has(action);
}

// What the administrator's Склад is built from: each product with how many are
// left, no prices, and her own sales of the last two days so she can see what
// the owner decided and take back a sale still waiting. Stock counts pending
// sales as gone, the same rule as maestro_product_stock.
export function stockForDesk({ products = [], receipts = [], sales = [], writeoffs = [], userId, since }) {
  const qtyOf = (rows, productId, keep = () => true) => rows
    .filter((row) => String(row.product_id) === String(productId) && keep(row))
    .reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
  const holdsStock = (sale) => sale.status === 'pending' || sale.status === 'approved';

  const stock = products
    .map((product) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      active: product.active,
      stock_qty: qtyOf(receipts, product.id) - qtyOf(sales, product.id, holdsStock) - qtyOf(writeoffs, product.id),
    }))
    .filter((product) => product.active !== false || product.stock_qty !== 0);

  const ownSales = sales
    .filter((sale) => String(sale.created_by_user_id) === String(userId) && String(sale.sale_date) >= String(since))
    .map(({ id, product_id, sale_date, qty, amount, payment_method, status, created_at }) => (
      { id, product_id, sale_date, qty, amount, payment_method, status, created_at }
    ));

  return { products: stock, product_sales: ownSales };
}

// Who sees a client's number whole: the owner, and the two who take bookings
// and call clients to confirm them — the administrator and the partner
// (owner's decision of 2026-10-16). A master never does.
export function seesFullPhones(role) {
  return ['owner', 'admin', 'partner'].includes(role);
}

// A client's number as a master sees it: the operator code and the last two
// digits, «+998 90 *** ** 22». Enough to tell two Азизs apart, not enough to
// take the base along.
export function maskPhoneForStaff(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('998') && digits.length === 12) {
    return `+998 ${digits.slice(3, 5)} *** ** ${digits.slice(-2)}`;
  }
  if (digits.length < 4) return '***';
  return `+${digits.slice(0, Math.min(3, digits.length - 2))} *** ** ${digits.slice(-2)}`;
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
