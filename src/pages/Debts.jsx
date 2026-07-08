import { useEffect, useMemo, useState } from 'react';
import {
  createDebt,
  createDebtPayment,
  deleteDebt,
  deleteDebtPayment,
  getDebtPayments,
  getDebts,
  updateDebt,
} from '../lib/api.js';
import {
  groupDebtsByCurrency,
  paymentsForDebt,
  remainingDebtAmount,
  totalOpenDebtsByCurrency,
  totalPaidForDebt,
} from '../utils/calculations.js';

function todayLocalDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function money(value, currency) {
  const amount = Math.round(Number(value) || 0).toLocaleString('ru-RU');
  return currency === 'USD' ? `$${amount}` : `${amount} сум`;
}

function statusLabel(isClosed) {
  return isClosed ? 'закрыт' : 'открыт';
}

function directionLabel(direction) {
  if (direction === 'i_owe') return 'я должен';
  if (direction === 'owed_to_me') return 'мне должны';
  return direction || '—';
}

function emptyDebtForm() {
  return {
    counterparty: '',
    direction: 'i_owe',
    amount: '',
    currency: 'UZS',
    start_date: todayLocalDate(),
    note: '',
  };
}

function emptyPaymentForm() {
  return {
    date: todayLocalDate(),
    amount: '',
    note: '',
    payment_method: '',
  };
}

function monthLabel(ym) {
  const labels = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
  const [year, month] = ym.split('-');
  return `${labels[Number(month) - 1]} ${String(year).slice(2)}`;
}

export default function Debts({ currentUser }) {
  const [debts, setDebts] = useState([]);
  const [payments, setPayments] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [debtForm, setDebtForm] = useState(emptyDebtForm);
  const [paymentForms, setPaymentForms] = useState({});
  const [activePaymentDebtId, setActivePaymentDebtId] = useState(null);
  const [gridShowClosed, setGridShowClosed] = useState(false);
  const [gridAllMonths, setGridAllMonths] = useState(false);

  const hasAccess = ['owner', 'finance'].includes(currentUser.role);

  const debtStats = useMemo(() => {
    const grouped = groupDebtsByCurrency(debts);
    const openTotals = totalOpenDebtsByCurrency(debts, payments);
    const openDebts = debts.filter((debt) => !debt.is_closed);
    const closedDebts = debts.filter((debt) => debt.is_closed);

    return {
      openUsd: openTotals.USD || 0,
      openUzs: openTotals.UZS || 0,
      closedUsd: (grouped.USD || []).filter((debt) => debt.is_closed).length,
      closedUzs: (grouped.UZS || []).filter((debt) => debt.is_closed).length,
      openCount: openDebts.length,
      closedCount: closedDebts.length,
    };
  }, [debts, payments]);

  const paymentMonths = useMemo(() => {
    const months = new Set([todayLocalDate().slice(0, 7)]);
    payments.forEach((payment) => {
      if (payment.date) months.add(String(payment.date).slice(0, 7));
    });
    const cols = [...months].sort();
    return gridAllMonths ? cols : cols.slice(-3);
  }, [gridAllMonths, payments]);

  async function loadDebtsData() {
    setIsLoading(true);
    setError('');

    try {
      const [debtRows, paymentRows] = await Promise.all([getDebts(), getDebtPayments()]);
      setDebts(debtRows);
      setPayments(paymentRows);
    } catch (loadError) {
      setError(loadError.message || 'Не удалось загрузить долги.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (hasAccess) {
      loadDebtsData();
    }
  }, [hasAccess]);

  function updateDebtForm(field, value) {
    setDebtForm((current) => ({ ...current, [field]: value }));
  }

  function updatePaymentForm(debtId, field, value) {
    setPaymentForms((current) => ({
      ...current,
      [debtId]: { ...(current[debtId] || emptyPaymentForm()), [field]: value },
    }));
  }

  async function handleCreateDebt(event) {
    event.preventDefault();
    setError('');
    setMessage('');

    if (!debtForm.counterparty.trim()) {
      setError('Введите контрагента.');
      return;
    }

    if ((Number(debtForm.amount) || 0) <= 0) {
      setError('Сумма долга должна быть больше 0.');
      return;
    }

    try {
      await createDebt({
        ...debtForm,
        counterparty: debtForm.counterparty.trim(),
        note: debtForm.note.trim(),
        created_by: currentUser.name || null,
      });
      setDebtForm(emptyDebtForm());
      setMessage('Долг добавлен.');
      await loadDebtsData();
    } catch (createError) {
      setError(createError.message || 'Не удалось добавить долг.');
    }
  }

  async function handleCreatePayment(debt) {
    setError('');
    setMessage('');

    const form = paymentForms[debt.id] || emptyPaymentForm();
    const amount = Number(form.amount) || 0;

    if (amount <= 0) {
      setError('Сумма оплаты должна быть больше 0.');
      return;
    }

    try {
      await createDebtPayment({
        debt_id: debt.id,
        date: form.date,
        amount,
        note: form.note.trim(),
        payment_method: form.payment_method.trim(),
        created_by: currentUser.name || null,
      });

      const remainingAfterPayment = remainingDebtAmount(debt, payments) - amount;
      if (remainingAfterPayment <= 0 && !debt.is_closed) {
        await updateDebt(debt.id, { is_closed: true, closed_at: new Date().toISOString() });
      }

      setPaymentForms((current) => ({ ...current, [debt.id]: emptyPaymentForm() }));
      setActivePaymentDebtId(null);
      setMessage('Оплата добавлена.');
      await loadDebtsData();
    } catch (createError) {
      setError(createError.message || 'Не удалось добавить оплату.');
    }
  }

  async function handleToggleDebt(debt) {
    setError('');
    setMessage('');

    try {
      await updateDebt(
        debt.id,
        debt.is_closed
          ? { is_closed: false }
          : { is_closed: true, closed_at: new Date().toISOString() },
      );
      setMessage(debt.is_closed ? 'Долг открыт.' : 'Долг закрыт.');
      await loadDebtsData();
    } catch (updateError) {
      setError(updateError.message || 'Не удалось обновить долг.');
    }
  }

  async function handleDeletePayment(payment) {
    if (!confirm(`Удалить оплату на ${money(payment.amount, debts.find((debt) => debt.id === payment.debt_id)?.currency)}?`)) return;

    setError('');
    setMessage('');

    const debt = debts.find((item) => item.id === payment.debt_id);

    try {
      await deleteDebtPayment(payment.id);

      if (debt) {
        const remainingAfterDelete = remainingDebtAmount(
          debt,
          payments.filter((item) => item.id !== payment.id),
        );
        if (debt.is_closed && remainingAfterDelete > 0) {
          await updateDebt(debt.id, { is_closed: false });
        }
      }

      setMessage('Оплата удалена.');
      await loadDebtsData();
    } catch (deleteError) {
      setError(deleteError.message || 'Не удалось удалить оплату.');
    }
  }

  async function handleDeleteDebt(debt) {
    const debtPayments = paymentsForDebt(payments, debt.id);
    if (debtPayments.length) {
      setError('Для безопасности долг с оплатами не удален. Сначала удалите оплаты по этому долгу.');
      return;
    }

    if (!confirm(`Удалить долг "${debt.counterparty}"?`)) return;

    setError('');
    setMessage('');

    try {
      await deleteDebt(debt.id);
      setMessage('Долг удален.');
      await loadDebtsData();
    } catch (deleteError) {
      setError(deleteError.message || 'Не удалось удалить долг.');
    }
  }

  if (!hasAccess) {
    return (
      <div className="placeholder-page">
        <h2>Долги</h2>
        <p>Нет доступа</p>
      </div>
    );
  }

  return (
    <div className="debts-page">
      <h2>Долги</h2>
      <p>Имя пользователя: {currentUser.name || 'Без имени'}</p>
      <p>Роль: {currentUser.role}</p>
      {currentUser.master_id ? <p>master_id: {currentUser.master_id}</p> : null}

      {isLoading ? <p className="empty-state">Загрузка долгов...</p> : null}
      {message ? <p className="success-text">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {!isLoading ? (
        <>
          <section className="data-section">
            <h3>Итоги</h3>
            <div className="totals-grid debts-totals">
              <div>
                <span>Открытые долги USD</span>
                <strong>{money(debtStats.openUsd, 'USD')}</strong>
              </div>
              <div>
                <span>Открытые долги UZS</span>
                <strong>{money(debtStats.openUzs, 'UZS')}</strong>
              </div>
              <div>
                <span>Закрытых долгов USD</span>
                <strong>{debtStats.closedUsd}</strong>
              </div>
              <div>
                <span>Закрытых долгов UZS</span>
                <strong>{debtStats.closedUzs}</strong>
              </div>
              <div>
                <span>Открытых долгов</span>
                <strong>{debtStats.openCount}</strong>
              </div>
              <div>
                <span>Закрытых долгов</span>
                <strong>{debtStats.closedCount}</strong>
              </div>
            </div>
          </section>

          <section className="data-section">
            <h3>Таблица по месяцам</h3>
            <div className="filter-buttons">
              <button className={gridShowClosed ? 'active' : ''} onClick={() => setGridShowClosed((value) => !value)} type="button">
                {gridShowClosed ? 'Скрыть погашенные' : 'Показать погашенные'}
              </button>
              <button className={gridAllMonths ? 'active' : ''} onClick={() => setGridAllMonths((value) => !value)} type="button">
                {gridAllMonths ? 'Последние месяцы' : 'Все месяцы'}
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Кому</th>
                    {paymentMonths.map((month) => (
                      <th key={month}>{monthLabel(month)}</th>
                    ))}
                    <th>Погашено</th>
                    <th>Остаток</th>
                  </tr>
                </thead>
                <tbody>
                  {['i_owe', 'owed_to_me'].map((direction) => (
                    debts
                      .filter((debt) => debt.direction === direction)
                      .filter((debt) => gridShowClosed || !debt.is_closed)
                      .map((debt) => {
                        const paid = totalPaidForDebt(payments, debt.id);
                        const remaining = remainingDebtAmount(debt, payments);

                        return (
                          <tr key={`grid-${debt.id}`}>
                            <td>{debt.counterparty} · {directionLabel(debt.direction)}</td>
                            {paymentMonths.map((month) => {
                              const monthTotal = payments
                                .filter((payment) => payment.debt_id === debt.id && String(payment.date).slice(0, 7) === month)
                                .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
                              return <td key={month}>{monthTotal ? money(monthTotal, debt.currency) : '·'}</td>;
                            })}
                            <td>{money(paid, debt.currency)}</td>
                            <td>{money(remaining, debt.currency)}</td>
                          </tr>
                        );
                      })
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="data-section">
            <h3>Добавить долг</h3>
            <form className="admin-form" onSubmit={handleCreateDebt}>
              <label>
                Контрагент
                <input onChange={(event) => updateDebtForm('counterparty', event.target.value)} value={debtForm.counterparty} />
              </label>
              <label>
                Direction
                <select onChange={(event) => updateDebtForm('direction', event.target.value)} value={debtForm.direction}>
                  <option value="i_owe">Я должен</option>
                  <option value="owed_to_me">Мне должны</option>
                </select>
              </label>
              <label>
                Сумма
                <input inputMode="numeric" onChange={(event) => updateDebtForm('amount', event.target.value)} type="number" value={debtForm.amount} />
              </label>
              <label>
                Валюта
                <select onChange={(event) => updateDebtForm('currency', event.target.value)} value={debtForm.currency}>
                  <option value="UZS">UZS</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <label>
                Start date
                <input onChange={(event) => updateDebtForm('start_date', event.target.value)} type="date" value={debtForm.start_date} />
              </label>
              <label className="wide-field">
                Note
                <input onChange={(event) => updateDebtForm('note', event.target.value)} value={debtForm.note} />
              </label>
              <button type="submit">Добавить долг</button>
            </form>
          </section>

          <section className="data-section">
            <h3>Список долгов</h3>
            {debts.length ? (
              <div className="debt-card-list">
                {debts.map((debt) => {
                  const debtPayments = paymentsForDebt(payments, debt.id);
                  const paid = totalPaidForDebt(payments, debt.id);
                  const remaining = remainingDebtAmount(debt, payments);
                  const paymentForm = paymentForms[debt.id] || emptyPaymentForm();
                  const showPaymentForm = activePaymentDebtId === debt.id;

                  return (
                    <article className="debt-card" key={debt.id}>
                      <div className="pending-sale-main">
                        <div>
                          <span>Контрагент</span>
                          <strong>{debt.counterparty || '—'}</strong>
                        </div>
                        <div>
                          <span>Direction</span>
                          <strong>{directionLabel(debt.direction)}</strong>
                        </div>
                        <div>
                          <span>Сумма</span>
                          <strong>{money(debt.amount, debt.currency)}</strong>
                        </div>
                        <div>
                          <span>Оплачено</span>
                          <strong>{money(paid, debt.currency)}</strong>
                        </div>
                        <div>
                          <span>Остаток</span>
                          <strong>{money(remaining, debt.currency)}</strong>
                        </div>
                        <div>
                          <span>Статус</span>
                          <strong>{statusLabel(debt.is_closed)}</strong>
                        </div>
                        <div>
                          <span>Start date</span>
                          <strong>{debt.start_date || '—'}</strong>
                        </div>
                        <div>
                          <span>Оплат</span>
                          <strong>{debtPayments.length}</strong>
                        </div>
                        <div>
                          <span>Note</span>
                          <strong>{debt.note || '—'}</strong>
                        </div>
                      </div>

                      {debtPayments.length ? (
                        <div className="payment-list">
                          {debtPayments.map((payment) => (
                            <div className="payment-row" key={payment.id}>
                              <span>{payment.date || '—'}</span>
                              <strong>{money(payment.amount, debt.currency)}</strong>
                              <span>{payment.payment_method || '—'}</span>
                              <span>{payment.note || '—'}</span>
                              <button className="table-action danger" onClick={() => handleDeletePayment(payment)} type="button">
                                Удалить
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {showPaymentForm ? (
                        <form className="admin-form compact-form" onSubmit={(event) => { event.preventDefault(); handleCreatePayment(debt); }}>
                          <label>
                            Date
                            <input onChange={(event) => updatePaymentForm(debt.id, 'date', event.target.value)} type="date" value={paymentForm.date} />
                          </label>
                          <label>
                            Amount
                            <input inputMode="numeric" onChange={(event) => updatePaymentForm(debt.id, 'amount', event.target.value)} type="number" value={paymentForm.amount} />
                          </label>
                          <label>
                            Method
                            <input onChange={(event) => updatePaymentForm(debt.id, 'payment_method', event.target.value)} value={paymentForm.payment_method} />
                          </label>
                          <label>
                            Note
                            <input onChange={(event) => updatePaymentForm(debt.id, 'note', event.target.value)} value={paymentForm.note} />
                          </label>
                          <button type="submit">Сохранить оплату</button>
                        </form>
                      ) : null}

                      <div className="pending-sale-actions">
                        <button onClick={() => setActivePaymentDebtId(showPaymentForm ? null : debt.id)} type="button">
                          Оплата
                        </button>
                        <button onClick={() => handleToggleDebt(debt)} type="button">
                          {debt.is_closed ? 'Открыть' : 'Закрыть'}
                        </button>
                        {debt.is_closed ? (
                          <button className="danger" onClick={() => handleDeleteDebt(debt)} type="button">
                            Удалить долг
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="empty-state">Долгов пока нет.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
