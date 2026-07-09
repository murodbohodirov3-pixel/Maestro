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
  paymentsForDebt,
  remainingDebtAmount,
  totalPaidForDebt,
} from '../utils/calculations.js';

const CURRENCIES = ['USD', 'UZS'];

function todayLocalDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function money(value, currency) {
  const amount = Math.max(0, Math.round(Number(value) || 0)).toLocaleString('ru-RU');
  return currency === 'USD' ? `$${amount}` : `${amount} сум`;
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

function monthKey(date) {
  return String(date).slice(0, 7);
}

function shiftMonth(key, offset) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(year, month - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const labels = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
  const [year, month] = key.split('-');
  return `${labels[Number(month) - 1]} ${String(year).slice(2)}`;
}

function fullDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU').format(new Date(`${value}T00:00:00`));
}

function paymentTotal(payments, currency, debtsById, targetMonth) {
  return payments.reduce((sum, payment) => {
    const debt = debtsById.get(String(payment.debt_id));
    if (!debt || debt.currency !== currency || monthKey(payment.date) !== targetMonth) return sum;
    return sum + (Number(payment.amount) || 0);
  }, 0);
}

function DebtChart({ currency, points }) {
  const width = 620;
  const height = 190;
  const padding = { top: 22, right: 18, bottom: 36, left: 18 };
  const maxValue = Math.max(...points.map((point) => point.value), 1);
  const x = (index) => padding.left + (index * (width - padding.left - padding.right)) / Math.max(points.length - 1, 1);
  const y = (value) => padding.top + (1 - value / maxValue) * (height - padding.top - padding.bottom);
  const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const area = `${padding.left},${height - padding.bottom} ${line} ${x(points.length - 1)},${height - padding.bottom}`;

  return (
    <div className="debt-chart-card">
      <div className="debt-chart-heading">
        <div>
          <span>Остаток долга · {currency}</span>
          <strong>{money(points.at(-2)?.value || 0, currency)}</strong>
        </div>
        <small>Пунктир — прогноз</small>
      </div>
      <svg aria-label={`График остатка долга в ${currency}`} className="debt-chart" role="img" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <linearGradient id={`debt-area-${currency}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--brass)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--brass)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((ratio) => (
          <line
            className="debt-chart-grid"
            key={ratio}
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + ratio * (height - padding.top - padding.bottom)}
            y2={padding.top + ratio * (height - padding.top - padding.bottom)}
          />
        ))}
        <polygon fill={`url(#debt-area-${currency})`} points={area} />
        <polyline className="debt-chart-line" points={line} />
        <line
          className="debt-chart-forecast"
          x1={x(points.length - 2)}
          x2={x(points.length - 1)}
          y1={y(points.at(-2).value)}
          y2={y(points.at(-1).value)}
        />
        {points.map((point, index) => (
          <g key={point.month}>
            <circle className={point.forecast ? 'forecast' : ''} cx={x(index)} cy={y(point.value)} r="4" />
            <text className="debt-chart-label" textAnchor="middle" x={x(index)} y={height - 12}>
              {monthLabel(point.month).split(' ')[0]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
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
  const [showClosed, setShowClosed] = useState(false);
  const [expandedHistoryIds, setExpandedHistoryIds] = useState([]);

  const hasAccess = ['owner', 'finance'].includes(currentUser.role);
  const myDebts = useMemo(() => debts.filter((debt) => debt.direction === 'i_owe'), [debts]);
  const debtsById = useMemo(
    () => new Map(myDebts.map((debt) => [String(debt.id), debt])),
    [myDebts],
  );

  const dashboard = useMemo(() => {
    const currentMonth = monthKey(todayLocalDate());
    const pastMonths = [-3, -2, -1].map((offset) => shiftMonth(currentMonth, offset));
    const chartMonths = [-5, -4, -3, -2, -1, 0].map((offset) => shiftMonth(currentMonth, offset));

    return CURRENCIES.map((currency) => {
      const currencyDebts = myDebts.filter((debt) => (debt.currency || 'UZS') === currency);
      const remaining = currencyDebts
        .filter((debt) => !debt.is_closed)
        .reduce((sum, debt) => sum + Math.max(0, remainingDebtAmount(debt, payments)), 0);
      const paidThisMonth = paymentTotal(payments, currency, debtsById, currentMonth);
      const averagePayment = pastMonths.reduce(
        (sum, month) => sum + paymentTotal(payments, currency, debtsById, month),
        0,
      ) / pastMonths.length;
      const forecast = Math.max(0, remaining - averagePayment);

      const points = chartMonths.map((month) => {
        const totalStarted = currencyDebts
          .filter((debt) => !debt.start_date || monthKey(debt.start_date) <= month)
          .reduce((sum, debt) => sum + (Number(debt.amount) || 0), 0);
        const paidThroughMonth = payments.reduce((sum, payment) => {
          const debt = debtsById.get(String(payment.debt_id));
          if (!debt || debt.currency !== currency || monthKey(payment.date) > month) return sum;
          return sum + (Number(payment.amount) || 0);
        }, 0);
        return { month, value: Math.max(0, totalStarted - paidThroughMonth) };
      });

      points.push({ month: shiftMonth(currentMonth, 1), value: forecast, forecast: true });
      return { currency, remaining, paidThisMonth, averagePayment, forecast, points };
    });
  }, [debtsById, myDebts, payments]);

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
    if (hasAccess) loadDebtsData();
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
      setError('Укажите, кому вы должны.');
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
    const remaining = Math.max(0, remainingDebtAmount(debt, payments));
    if (amount <= 0) {
      setError('Сумма платежа должна быть больше 0.');
      return;
    }
    if (amount > remaining) {
      setError(`Платёж больше остатка по долгу (${money(remaining, debt.currency)}).`);
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
      if (remaining - amount <= 0 && !debt.is_closed) {
        await updateDebt(debt.id, { is_closed: true, closed_at: new Date().toISOString() });
      }
      setPaymentForms((current) => ({ ...current, [debt.id]: emptyPaymentForm() }));
      setActivePaymentDebtId(null);
      setMessage('Платёж сохранён. Остаток пересчитан.');
      await loadDebtsData();
    } catch (createError) {
      setError(createError.message || 'Не удалось сохранить платёж.');
    }
  }

  async function handleToggleDebt(debt) {
    if (!debt.is_closed) return;
    setError('');
    setMessage('');
    try {
      await updateDebt(debt.id, { is_closed: false });
      setMessage('Долг снова открыт.');
      await loadDebtsData();
    } catch (updateError) {
      setError(updateError.message || 'Не удалось обновить долг.');
    }
  }

  async function handleDeletePayment(payment) {
    const debt = debtsById.get(String(payment.debt_id));
    if (!confirm(`Удалить платёж ${money(payment.amount, debt?.currency)}?`)) return;
    setError('');
    setMessage('');
    try {
      await deleteDebtPayment(payment.id);
      if (debt?.is_closed) await updateDebt(debt.id, { is_closed: false });
      setMessage('Платёж удалён, остаток пересчитан.');
      await loadDebtsData();
    } catch (deleteError) {
      setError(deleteError.message || 'Не удалось удалить платёж.');
    }
  }

  async function handleDeleteDebt(debt) {
    if (paymentsForDebt(payments, debt.id).length) {
      setError('Долг с историей платежей нельзя удалить. Сначала удалите платежи.');
      return;
    }
    if (!confirm(`Удалить долг «${debt.counterparty}»?`)) return;
    setError('');
    setMessage('');
    try {
      await deleteDebt(debt.id);
      setMessage('Долг удалён.');
      await loadDebtsData();
    } catch (deleteError) {
      setError(deleteError.message || 'Не удалось удалить долг.');
    }
  }

  function toggleHistory(debtId) {
    setExpandedHistoryIds((current) => (
      current.includes(debtId)
        ? current.filter((id) => id !== debtId)
        : [...current, debtId]
    ));
  }

  if (!hasAccess) {
    return (
      <div className="placeholder-page">
        <h2>Долги</h2>
        <p>Нет доступа</p>
      </div>
    );
  }

  const visibleDebts = myDebts
    .filter((debt) => showClosed || !debt.is_closed)
    .sort((a, b) => Number(a.is_closed) - Number(b.is_closed));
  const activeCount = myDebts.filter((debt) => !debt.is_closed).length;
  const closedCount = myDebts.filter((debt) => debt.is_closed).length;

  return (
    <div className="debts-page debt-dashboard">
      <div className="debt-page-heading">
        <div>
          <p className="debt-eyebrow">Мои обязательства</p>
          <h2>Долги</h2>
          <p>Следите за остатком и каждый месяц фиксируйте погашения.</p>
        </div>
        <button className="btn" onClick={() => document.getElementById('new-debt-form')?.scrollIntoView({ behavior: 'smooth' })} type="button">
          + Добавить долг
        </button>
      </div>

      {isLoading ? <p className="empty-state">Загрузка долгов...</p> : null}
      {message ? <p className="success-text">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {!isLoading ? (
        <>
          <section className="debt-summary-grid">
            {dashboard.map((item) => (
              <article className="debt-summary-card" key={item.currency}>
                <span>Осталось выплатить · {item.currency}</span>
                <strong>{money(item.remaining, item.currency)}</strong>
                <div>
                  <p>
                    <span>Погашено в этом месяце</span>
                    <b>{money(item.paidThisMonth, item.currency)}</b>
                  </p>
                  <p>
                    <span>Ожидаемый остаток через месяц</span>
                    <b>{money(item.forecast, item.currency)}</b>
                  </p>
                </div>
                <small>
                  Прогноз по среднему платежу за 3 прошлых месяца: {money(item.averagePayment, item.currency)}
                </small>
              </article>
            ))}
          </section>

          <section className="data-section debt-chart-section">
            <div className="debt-section-heading">
              <div>
                <h3>Как уменьшается долг</h3>
                <p>История остатка за 6 месяцев и прогноз на следующий.</p>
              </div>
            </div>
            <div className="debt-charts">
              {dashboard.map((item) => (
                <DebtChart currency={item.currency} key={item.currency} points={item.points} />
              ))}
            </div>
          </section>

          <section className="data-section">
            <div className="debt-section-heading">
              <div>
                <h3>Кому я должен</h3>
                <p>{activeCount} активных · {closedCount} погашенных</p>
              </div>
              <button className={`btn ghost ${showClosed ? 'active' : ''}`} onClick={() => setShowClosed((value) => !value)} type="button">
                {showClosed ? 'Скрыть погашенные' : 'Показать погашенные'}
              </button>
            </div>

            {visibleDebts.length ? (
              <div className="debt-card-list">
                {visibleDebts.map((debt) => {
                  const debtPayments = paymentsForDebt(payments, debt.id)
                    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
                  const paid = totalPaidForDebt(payments, debt.id);
                  const remaining = Math.max(0, remainingDebtAmount(debt, payments));
                  const progress = Math.min(100, Math.round((paid / Math.max(Number(debt.amount) || 1, 1)) * 100));
                  const paymentForm = paymentForms[debt.id] || emptyPaymentForm();
                  const showPaymentForm = activePaymentDebtId === debt.id;
                  const showHistory = expandedHistoryIds.includes(debt.id);
                  const recentMonths = [-3, -2, -1].map((offset) => shiftMonth(monthKey(todayLocalDate()), offset));
                  const average = recentMonths.reduce((sum, month) => (
                    sum + debtPayments
                      .filter((payment) => monthKey(payment.date) === month)
                      .reduce((monthSum, payment) => monthSum + (Number(payment.amount) || 0), 0)
                  ), 0) / recentMonths.length;
                  const payoffMonths = average > 0 ? Math.ceil(remaining / average) : null;

                  return (
                    <article className={`debt-card debt-person-card ${debt.is_closed ? 'closed' : ''}`} key={debt.id}>
                      <div className="debt-person-heading">
                        <div>
                          <span className="debt-status">{debt.is_closed ? 'Погашен' : 'Активный долг'}</span>
                          <h4>{debt.counterparty || 'Без названия'}</h4>
                          <small>С {fullDate(debt.start_date)}{debt.note ? ` · ${debt.note}` : ''}</small>
                        </div>
                        <div className="debt-person-balance">
                          <span>Осталось</span>
                          <strong>{money(remaining, debt.currency)}</strong>
                        </div>
                      </div>

                      <div className="debt-progress-track">
                        <span style={{ width: `${progress}%` }} />
                      </div>
                      <div className="debt-progress-meta">
                        <span>Погашено {money(paid, debt.currency)} из {money(debt.amount, debt.currency)}</span>
                        <strong>{progress}%</strong>
                      </div>

                      <div className="debt-person-stats">
                        <div>
                          <span>Средний платёж</span>
                          <strong>{money(average, debt.currency)} / мес.</strong>
                        </div>
                        <div>
                          <span>Последний платёж</span>
                          <strong>{debtPayments[0] ? `${money(debtPayments[0].amount, debt.currency)} · ${fullDate(debtPayments[0].date)}` : 'Пока нет'}</strong>
                        </div>
                        <div>
                          <span>Примерно до погашения</span>
                          <strong>{debt.is_closed ? 'Погашен' : payoffMonths ? `${payoffMonths} мес.` : 'Нужны платежи'}</strong>
                        </div>
                      </div>

                      {showPaymentForm ? (
                        <form className="admin-form compact-form debt-payment-form" onSubmit={(event) => { event.preventDefault(); handleCreatePayment(debt); }}>
                          <label>
                            Дата
                            <input onChange={(event) => updatePaymentForm(debt.id, 'date', event.target.value)} type="date" value={paymentForm.date} />
                          </label>
                          <label>
                            Сумма
                            <input inputMode="numeric" max={remaining} min="1" onChange={(event) => updatePaymentForm(debt.id, 'amount', event.target.value)} type="number" value={paymentForm.amount} />
                          </label>
                          <label>
                            Способ оплаты
                            <input onChange={(event) => updatePaymentForm(debt.id, 'payment_method', event.target.value)} placeholder="Наличные, карта..." value={paymentForm.payment_method} />
                          </label>
                          <label>
                            Комментарий
                            <input onChange={(event) => updatePaymentForm(debt.id, 'note', event.target.value)} placeholder="Необязательно" value={paymentForm.note} />
                          </label>
                          <button className="btn" type="submit">Сохранить платёж</button>
                        </form>
                      ) : null}

                      {showHistory && debtPayments.length ? (
                        <div className="debt-payment-history">
                          {debtPayments.map((payment) => (
                            <div className="debt-payment-row" key={payment.id}>
                              <div>
                                <strong>{money(payment.amount, debt.currency)}</strong>
                                <span>{payment.note || payment.payment_method || 'Погашение долга'}</span>
                              </div>
                              <time>{fullDate(payment.date)}</time>
                              <button aria-label="Удалить платёж" className="debt-delete-payment" onClick={() => handleDeletePayment(payment)} type="button">×</button>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div className="debt-card-actions">
                        {!debt.is_closed ? (
                          <button className="btn" onClick={() => setActivePaymentDebtId(showPaymentForm ? null : debt.id)} type="button">
                            {showPaymentForm ? 'Отменить' : 'Внести платёж'}
                          </button>
                        ) : null}
                        <button className="btn ghost" disabled={!debtPayments.length} onClick={() => toggleHistory(debt.id)} type="button">
                          {showHistory ? 'Скрыть историю' : `История (${debtPayments.length})`}
                        </button>
                        {debt.is_closed ? (
                          <button className="btn ghost" onClick={() => handleToggleDebt(debt)} type="button">
                            Открыть снова
                          </button>
                        ) : null}
                        {debt.is_closed && !debtPayments.length ? (
                          <button className="btn ghost danger" onClick={() => handleDeleteDebt(debt)} type="button">Удалить</button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="empty-state">{showClosed ? 'Долгов пока нет.' : 'Активных долгов нет — отличный результат.'}</p>
            )}
          </section>

          <section className="data-section" id="new-debt-form">
            <div className="debt-section-heading">
              <div>
                <h3>Добавить новый долг</h3>
                <p>Укажите начальную сумму — выплаты будут уменьшать остаток автоматически.</p>
              </div>
            </div>
            <form className="admin-form debt-new-form" onSubmit={handleCreateDebt}>
              <label>
                Кому я должен
                <input onChange={(event) => updateDebtForm('counterparty', event.target.value)} placeholder="Имя или организация" value={debtForm.counterparty} />
              </label>
              <label>
                Сумма долга
                <input inputMode="numeric" min="1" onChange={(event) => updateDebtForm('amount', event.target.value)} type="number" value={debtForm.amount} />
              </label>
              <label>
                Валюта
                <select onChange={(event) => updateDebtForm('currency', event.target.value)} value={debtForm.currency}>
                  <option value="UZS">UZS — сум</option>
                  <option value="USD">USD — доллар</option>
                </select>
              </label>
              <label>
                Дата начала
                <input onChange={(event) => updateDebtForm('start_date', event.target.value)} type="date" value={debtForm.start_date} />
              </label>
              <label className="wide-field">
                Заметка
                <input onChange={(event) => updateDebtForm('note', event.target.value)} placeholder="За что долг, условия..." value={debtForm.note} />
              </label>
              <button className="btn" type="submit">Добавить долг</button>
            </form>
          </section>
        </>
      ) : null}
    </div>
  );
}
