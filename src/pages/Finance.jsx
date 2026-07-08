import { useEffect, useMemo, useState } from 'react';
import {
  createExpense,
  deleteExpense,
  getApprovedSales,
  getExpenses,
  getFines,
  getMasters,
} from '../lib/api.js';
import {
  expensesBySection,
  getCurrentMonthRange,
  getPreviousMonthRange,
  getTodayRange,
  investmentSummary,
  isDateInRange,
  masterFines,
  masterGrossPay,
  masterNetPay,
  masterPayoutSum,
  masterRevenue,
  profit,
  salonCut,
  totalCard,
  totalCash,
  totalExpenses,
  totalFines,
  totalQr,
  totalSalesAmount,
} from '../utils/calculations.js';

function money(value) {
  return Math.round(Number(value) || 0).toLocaleString('ru-RU');
}

function todayLocalDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function expenseKind(expense) {
  return expense.category || expense.section || '—';
}

function saleClients(sale) {
  return Number(sale.clients_count ?? sale.cl ?? 1) || 1;
}

function getFinanceRange(period, customFrom, customTo) {
  if (period === 'today') return getTodayRange();
  if (period === 'current_month') return getCurrentMonthRange();
  if (period === 'previous_month') return getPreviousMonthRange();
  if (period === 'custom') return { from: customFrom, to: customTo };
  return { from: '', to: '' };
}

function emptyExpenseForm() {
  return {
    date: todayLocalDate(),
    section: 'ishxona',
    category: '',
    name: '',
    qty: '',
    amount_uzs: '',
    usd_rate: '',
    minus_from: 'ishxona',
    note: '',
  };
}

export default function Finance({ currentUser }) {
  const [sales, setSales] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [fines, setFines] = useState([]);
  const [masters, setMasters] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingExpense, setIsSavingExpense] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [period, setPeriod] = useState('current_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [expenseTab, setExpenseTab] = useState('ishxona');
  const [expenseForm, setExpenseForm] = useState(emptyExpenseForm);

  const hasAccess = ['owner', 'finance'].includes(currentUser.role);
  const range = useMemo(
    () => getFinanceRange(period, customFrom, customTo),
    [customFrom, customTo, period],
  );

  const filteredSales = useMemo(
    () => sales.filter((sale) => isDateInRange(sale.sale_date || sale.d, range.from, range.to)),
    [range.from, range.to, sales],
  );

  const filteredExpenses = useMemo(
    () => expenses.filter((expense) => isDateInRange(expense.date, range.from, range.to)),
    [expenses, range.from, range.to],
  );

  const filteredFines = useMemo(
    () => fines.filter((fine) => isDateInRange(fine.fine_date || fine.d, range.from, range.to)),
    [fines, range.from, range.to],
  );

  const activeMasters = useMemo(() => masters.filter((master) => master.active), [masters]);
  const visibleExpenses = useMemo(
    () => expensesBySection(filteredExpenses, expenseTab),
    [expenseTab, filteredExpenses],
  );

  const totals = useMemo(() => {
    const payout = masterPayoutSum(filteredSales, activeMasters, filteredFines);
    const cut = salonCut(filteredSales, activeMasters, filteredFines);
    const ishxona = totalExpenses(expensesBySection(filteredExpenses, 'ishxona'));

    return {
      salesAmount: totalSalesAmount(filteredSales),
      cash: totalCash(filteredSales),
      card: totalCard(filteredSales),
      qr: totalQr(filteredSales),
      fines: totalFines(filteredFines),
      salesCount: filteredSales.length,
      clientsCount: filteredSales.reduce((sum, sale) => sum + saleClients(sale), 0),
      payout,
      salonCut: cut,
      ishxonaExpenses: ishxona,
      profit: profit(filteredSales, activeMasters, filteredExpenses, filteredFines),
      allExpenses: totalExpenses(filteredExpenses),
      murodExpenses: totalExpenses(expensesBySection(filteredExpenses, 'murod')),
      jamshidExpenses: totalExpenses(expensesBySection(filteredExpenses, 'jamshid')),
      tabExpenses: totalExpenses(visibleExpenses),
    };
  }, [activeMasters, filteredExpenses, filteredFines, filteredSales, visibleExpenses]);

  const investments = useMemo(
    () => [
      { key: 'murod', name: 'Мурод', summary: investmentSummary(expenses, 'murod') },
      { key: 'jamshid', name: 'Жамшид', summary: investmentSummary(expenses, 'jamshid') },
    ],
    [expenses],
  );

  async function loadFinanceData() {
    setIsLoading(true);
    setError('');

    try {
      const [approvedSalesRows, expenseRows, fineRows, masterRows] = await Promise.all([
        getApprovedSales(),
        getExpenses(),
        getFines(),
        getMasters(),
      ]);

      setSales(approvedSalesRows);
      setExpenses(expenseRows);
      setFines(fineRows);
      setMasters(masterRows);
    } catch (loadError) {
      setError(loadError.message || 'Не удалось загрузить финансовый отчет.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (hasAccess) {
      loadFinanceData();
    }
  }, [hasAccess]);

  function updateExpenseForm(field, value) {
    setExpenseForm((current) => ({ ...current, [field]: value }));
  }

  async function handleCreateExpense(event) {
    event.preventDefault();
    setError('');
    setMessage('');

    if (!expenseForm.name.trim()) {
      setError('Введите название расхода.');
      return;
    }

    if ((Number(expenseForm.amount_uzs) || 0) <= 0) {
      setError('Сумма расхода должна быть больше 0.');
      return;
    }

    setIsSavingExpense(true);

    try {
      await createExpense({
        ...expenseForm,
        name: expenseForm.name.trim(),
        category: expenseForm.category.trim(),
        note: expenseForm.note.trim(),
        created_by: currentUser.name || null,
      });
      setExpenseForm(emptyExpenseForm());
      setMessage('Расход добавлен.');
      await loadFinanceData();
    } catch (saveError) {
      setError(saveError.message || 'Не удалось добавить расход.');
    } finally {
      setIsSavingExpense(false);
    }
  }

  async function handleDeleteExpense(expense) {
    if (!confirm(`Удалить расход "${expense.name || 'без названия'}"?`)) return;

    setError('');
    setMessage('');

    try {
      await deleteExpense(expense.id);
      setMessage('Расход удален.');
      await loadFinanceData();
    } catch (deleteError) {
      setError(deleteError.message || 'Не удалось удалить расход.');
    }
  }

  if (!hasAccess) {
    return (
      <div className="placeholder-page">
        <h2>Финансы</h2>
        <p>Нет доступа</p>
      </div>
    );
  }

  return (
    <div className="finance-page">
      <h2>Финансы</h2>
      <p>Имя пользователя: {currentUser.name || 'Без имени'}</p>
      <p>Роль: {currentUser.role}</p>
      {currentUser.master_id ? <p>master_id: {currentUser.master_id}</p> : null}

      {isLoading ? <p className="empty-state">Загрузка финансового отчета...</p> : null}
      {message ? <p className="success-text">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {!isLoading ? (
        <>
          <section className="filter-panel">
            <div className="filter-buttons">
              <button className={period === 'today' ? 'active' : ''} onClick={() => setPeriod('today')} type="button">
                Сегодня
              </button>
              <button
                className={period === 'current_month' ? 'active' : ''}
                onClick={() => setPeriod('current_month')}
                type="button"
              >
                Этот месяц
              </button>
              <button
                className={period === 'previous_month' ? 'active' : ''}
                onClick={() => setPeriod('previous_month')}
                type="button"
              >
                Прошлый месяц
              </button>
              <button className={period === 'all' ? 'active' : ''} onClick={() => setPeriod('all')} type="button">
                Все время
              </button>
              <button
                className={period === 'custom' ? 'active' : ''}
                onClick={() => setPeriod('custom')}
                type="button"
              >
                Произвольный период
              </button>
            </div>
            {period === 'custom' ? (
              <div className="date-range">
                <label>
                  date_from
                  <input onChange={(event) => setCustomFrom(event.target.value)} type="date" value={customFrom} />
                </label>
                <label>
                  date_to
                  <input onChange={(event) => setCustomTo(event.target.value)} type="date" value={customTo} />
                </label>
              </div>
            ) : null}
          </section>

          <section className="data-section">
            <h3>Сводка</h3>
            <div className="totals-grid finance-totals">
              <div>
                <span>Approved выручка</span>
                <strong>{money(totals.salesAmount)}</strong>
              </div>
              <div>
                <span>Выплаты мастерам</span>
                <strong>{money(totals.payout)}</strong>
              </div>
              <div>
                <span>Штрафы</span>
                <strong>{money(totals.fines)}</strong>
              </div>
              <div>
                <span>Салону осталось</span>
                <strong>{money(totals.salonCut)}</strong>
              </div>
              <div>
                <span>Расходы ishxona</span>
                <strong>{money(totals.ishxonaExpenses)}</strong>
              </div>
              <div>
                <span>Чистая прибыль</span>
                <strong>{money(totals.profit)}</strong>
              </div>
              <div>
                <span>Наличные</span>
                <strong>{money(totals.cash)}</strong>
              </div>
              <div>
                <span>Карта</span>
                <strong>{money(totals.card)}</strong>
              </div>
              <div>
                <span>QR</span>
                <strong>{money(totals.qr)}</strong>
              </div>
              <div>
                <span>Approved-записей</span>
                <strong>{totals.salesCount}</strong>
              </div>
              <div>
                <span>Клиентов</span>
                <strong>{totals.clientsCount}</strong>
              </div>
            </div>
          </section>

          <section className="data-section">
            <h3>Выплаты мастерам</h3>
            {activeMasters.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Имя</th>
                      <th>%</th>
                      <th>Approved выручка</th>
                      <th>Начисление</th>
                      <th>Штрафы</th>
                      <th>К выплате</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeMasters.map((master) => {
                      const revenue = masterRevenue(filteredSales, master.id);
                      const grossPay = masterGrossPay(revenue, master.pct);
                      const finesAmount = masterFines(filteredFines, master.id);
                      const netPay = masterNetPay(grossPay, finesAmount);

                      return (
                        <tr key={master.id}>
                          <td>{master.name}</td>
                          <td>{master.pct}</td>
                          <td>{money(revenue)}</td>
                          <td>{money(grossPay)}</td>
                          <td>{money(finesAmount)}</td>
                          <td>{money(netPay)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-state">Активных мастеров пока нет.</p>
            )}
          </section>

          <section className="data-section">
            <h3>Вложения и остатки</h3>
            <div className="investment-grid">
              {investments.map(({ key, name, summary }) => (
                <div className="investment-card" key={key}>
                  <strong>{name}</strong>
                  <span>Вложено: ${money(summary.investedUsd)} · {money(summary.invested)} сум</span>
                  <span>Возвращено: ${money(summary.returnedUsd)} · {money(summary.returned)} сум</span>
                  <span>Остаток: ${money(summary.investedUsd - summary.returnedUsd)} · {money(summary.invested - summary.returned)} сум</span>
                </div>
              ))}
            </div>
          </section>

          <section className="data-section">
            <h3>Расходы</h3>
            <div className="filter-buttons">
              {['ishxona', 'murod', 'jamshid', 'all'].map((tab) => (
                <button
                  className={expenseTab === tab ? 'active' : ''}
                  key={tab}
                  onClick={() => setExpenseTab(tab)}
                  type="button"
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="totals-grid finance-totals">
              <div>
                <span>Total expenses all</span>
                <strong>{money(totals.allExpenses)}</strong>
              </div>
              <div>
                <span>Ishxona expenses</span>
                <strong>{money(totals.ishxonaExpenses)}</strong>
              </div>
              <div>
                <span>Murod expenses</span>
                <strong>{money(totals.murodExpenses)}</strong>
              </div>
              <div>
                <span>Jamshid expenses</span>
                <strong>{money(totals.jamshidExpenses)}</strong>
              </div>
              <div>
                <span>Текущая вкладка</span>
                <strong>{money(totals.tabExpenses)}</strong>
              </div>
            </div>

            {visibleExpenses.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Section/category</th>
                      <th>Name</th>
                      <th>Qty</th>
                      <th>Amount</th>
                      <th>USD rate</th>
                      <th>Minus from</th>
                      <th>Note</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleExpenses.map((expense) => (
                      <tr key={expense.id}>
                        <td>{expense.date || '—'}</td>
                        <td>{expenseKind(expense)}</td>
                        <td>{expense.name || '—'}</td>
                        <td>{expense.qty || '—'}</td>
                        <td>{money(expense.amount_uzs)}</td>
                        <td>{expense.usd_rate || '—'}</td>
                        <td>{expense.minus_from || '—'}</td>
                        <td>{expense.note || '—'}</td>
                        <td>
                          <button className="table-action danger" onClick={() => handleDeleteExpense(expense)} type="button">
                            Удалить
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-state">Расходов за выбранный период нет.</p>
            )}
          </section>

          <section className="data-section">
            <h3>Добавить расход</h3>
            <form className="expense-form" onSubmit={handleCreateExpense}>
              <label>
                Date
                <input onChange={(event) => updateExpenseForm('date', event.target.value)} type="date" value={expenseForm.date} />
              </label>
              <label>
                Section
                <select onChange={(event) => updateExpenseForm('section', event.target.value)} value={expenseForm.section}>
                  <option value="ishxona">ishxona</option>
                  <option value="murod">murod</option>
                  <option value="jamshid">jamshid</option>
                </select>
              </label>
              <label>
                Category
                <input onChange={(event) => updateExpenseForm('category', event.target.value)} value={expenseForm.category} />
              </label>
              <label>
                Name
                <input onChange={(event) => updateExpenseForm('name', event.target.value)} value={expenseForm.name} />
              </label>
              <label>
                Qty
                <input inputMode="numeric" onChange={(event) => updateExpenseForm('qty', event.target.value)} type="number" value={expenseForm.qty} />
              </label>
              <label>
                Amount UZS
                <input inputMode="numeric" onChange={(event) => updateExpenseForm('amount_uzs', event.target.value)} type="number" value={expenseForm.amount_uzs} />
              </label>
              <label>
                USD rate
                <input inputMode="numeric" onChange={(event) => updateExpenseForm('usd_rate', event.target.value)} type="number" value={expenseForm.usd_rate} />
              </label>
              <label>
                Minus from
                <select onChange={(event) => updateExpenseForm('minus_from', event.target.value)} value={expenseForm.minus_from}>
                  <option value="ishxona">ishxona</option>
                  <option value="murod">murod</option>
                  <option value="jamshid">jamshid</option>
                </select>
              </label>
              <label className="wide-field">
                Note
                <input onChange={(event) => updateExpenseForm('note', event.target.value)} value={expenseForm.note} />
              </label>
              <button disabled={isSavingExpense} type="submit">
                {isSavingExpense ? 'Сохраняю...' : 'Добавить расход'}
              </button>
            </form>
          </section>
        </>
      ) : null}
    </div>
  );
}
