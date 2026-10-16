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

// The administrator (role 'admin') works the front desk. As decided by the
// owner on 2026-10-15, she sells goods from Склад and nothing else: deliveries
// and write-offs are the owner's, every sale she enters waits for him, and she
// sees no revenue, payouts, expenses or purchase prices. The calendar comes
// back later and will join this list then.
export const ADMIN_ROLE = 'admin';

const ADMIN_ACTIONS = new Set(['load', 'addProductSale', 'delStockEntry']);

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
