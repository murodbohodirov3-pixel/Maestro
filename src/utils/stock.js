// Склад: what is on the shelf, what it cost and what selling it earned.
//
// A sale's amount is what the salon kept after the seller's share. Its
// unit_cost is the average purchase price fixed when the sale was entered, so
// a later, dearer delivery never rewrites an old sale's margin. The server
// applies the same rules (supabase/migrations/20261014160000_stock.sql); these
// functions only read what it stored.

import { inRange } from './reporting.js';

// A pending sale already holds its units: the bottle has left the shelf even
// while the owner is still deciding. A rejected one gives them back.
const HOLDS_STOCK = new Set(['pending', 'approved']);

function sumQty(rows) {
  return rows.reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
}

export function productSaleCost(sale) {
  return (Number(sale?.unit_cost) || 0) * (Number(sale?.qty) || 0);
}

export function productSaleMargin(sale) {
  return (Number(sale?.amount) || 0) - productSaleCost(sale);
}

// The average price paid per unit over every receipt, the figure a new sale
// is priced at.
export function averageUnitCost(receipts) {
  const qty = sumQty(receipts);
  if (!qty) return 0;
  const total = receipts.reduce((sum, row) => sum + (Number(row.total_cost) || (Number(row.unit_cost) || 0) * (Number(row.qty) || 0)), 0);
  return Math.round((total / qty) * 100) / 100;
}

// One line per product: how many are left and what they are worth at the
// average purchase price. Products still in stock come first.
export function stockLevels({ products = [], receipts = [], sales = [], writeoffs = [] }) {
  const of = (rows, product) => rows.filter((row) => String(row.product_id) === String(product.id));
  return products
    .map((product) => {
      const productReceipts = of(receipts, product);
      const received = sumQty(productReceipts);
      const sold = sumQty(of(sales, product).filter((sale) => HOLDS_STOCK.has(sale.status)));
      const writtenOff = sumQty(of(writeoffs, product));
      const qty = received - sold - writtenOff;
      const unitCost = averageUnitCost(productReceipts);
      return {
        product,
        received,
        sold,
        writtenOff,
        qty,
        unitCost,
        value: Math.max(0, qty) * unitCost,
      };
    })
    .sort((left, right) => (
      Number(right.qty > 0) - Number(left.qty > 0)
      || String(left.product.name).localeCompare(String(right.product.name), 'ru')
    ));
}

export function pendingProductSales(sales = []) {
  return sales.filter((sale) => sale.status === 'pending');
}

export function approvedProductSalesIn(sales = [], range) {
  return sales.filter((sale) => (
    sale.status === 'approved' && range && inRange(String(sale.sale_date || ''), range.from, range.to)
  ));
}

// What goods brought the salon in a period: the money kept, what those units
// had cost, and the difference. Only sales the owner approved count.
export function productSalesSummary(sales = [], range) {
  const rows = approvedProductSalesIn(sales, range);
  const amount = rows.reduce((sum, sale) => sum + (Number(sale.amount) || 0), 0);
  const cost = rows.reduce((sum, sale) => sum + productSaleCost(sale), 0);
  return {
    count: rows.length,
    qty: sumQty(rows),
    amount,
    cost: Math.round(cost),
    margin: Math.round(amount - cost),
  };
}

// The money of some product sales by payment method, for the approval totals.
export function goodsPaymentMix(sales = []) {
  const mix = { cash: 0, card: 0, qr: 0 };
  sales.forEach((sale) => {
    if (mix[sale.payment_method] !== undefined) mix[sale.payment_method] += Number(sale.amount) || 0;
  });
  return { ...mix, total: mix.cash + mix.card + mix.qr };
}

// Search that forgives case, ё, extra spaces and word order: «шамп реуз»
// finds «Шампунь Reuzel» only if every typed piece is in the name.
export function normalizeProductSearch(text) {
  return String(text ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

export function productMatches(product, query) {
  const words = normalizeProductSearch(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const name = normalizeProductSearch(product?.name);
  return words.every((word) => name.includes(word));
}

// Products most recently received or sold first, so the ones in daily use are
// offered before anything is typed.
export function productsByRecentUse(products = [], receipts = [], sales = []) {
  const lastUsed = new Map();
  [...receipts, ...sales].forEach((row) => {
    const key = String(row.product_id);
    const stamp = `${row.sale_date || row.receipt_date || ''}T${row.created_at || ''}`;
    if (!lastUsed.has(key) || stamp > lastUsed.get(key)) lastUsed.set(key, stamp);
  });
  return [...products].sort((left, right) => (
    String(lastUsed.get(String(right.id)) || '').localeCompare(String(lastUsed.get(String(left.id)) || ''))
    || String(left.name).localeCompare(String(right.name), 'ru')
  ));
}

// The cash goods brought in, for profit. Purchases are already expenses on
// the day they were made, so profit adds the money a sale brought and not its
// margin: counting the margin would subtract the purchase a second time.
export function productIncome(sales = [], range) {
  return approvedProductSalesIn(sales, range).reduce((sum, sale) => sum + (Number(sale.amount) || 0), 0);
}
