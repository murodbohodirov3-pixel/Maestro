import { useEffect, useMemo, useState } from 'react';
import {
  callLegacyApi,
  captureTelegramRedirectAuth,
  clearWidgetAuth,
  getTelegramFirstName,
  needsTelegramLogin,
} from './lib/legacyApi.js';

const APP_VERSION = 'react-restore-v1';
const TODAY = localDate();

function localDate(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function money(value) {
  return Math.round(Number(value) || 0).toLocaleString('ru-RU');
}

function saleTotal(sale) {
  return (Number(sale.cash) || 0) + (Number(sale.card) || 0) + (Number(sale.qr) || 0);
}

function isPendingOwnerApproval(sale) {
  return sale.status === 'pending' && sale.comment === 'owner_approval_required';
}

function isRejectedByOwner(sale) {
  return sale.status === 'rejected' && sale.comment === 'owner_approval_rejected';
}

function isCountedSale(sale) {
  return !isPendingOwnerApproval(sale) && !isRejectedByOwner(sale);
}

function rowDate(row, primary = 'd') {
  return row?.[primary] || row?.date || row?.sale_date || row?.attendance_date || row?.fine_date || '';
}

function clients(sale) {
  return Number(sale.cl ?? sale.clients_count ?? 1) || 1;
}

function displayTime(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{2}:\d{2}/.test(text)) return text.slice(0, 5);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text.slice(0, 5) : date.toTimeString().slice(0, 5);
}

function displayDateTime(value) {
  if (!value) return 'время не указано';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tashkent',
  });
}

function clientType(sale) {
  if (sale.is_new_client === true) return 'новый';
  if (sale.is_new_client === false) return 'постоянный';
  return 'тип не указан';
}

function timeToMinutes(value) {
  const time = displayTime(value);
  if (!time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function minutesLate(arrived, shiftStart = '09:00') {
  const arrivedMinutes = timeToMinutes(arrived);
  const shiftMinutes = timeToMinutes(shiftStart);
  if (arrivedMinutes == null || shiftMinutes == null) return 0;
  return Math.max(0, arrivedMinutes - shiftMinutes);
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const radius = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function currentMonthRange() {
  const now = new Date();
  return {
    from: localDate(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: localDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
}

function weekRange(anchor = new Date()) {
  const day = (anchor.getDay() + 6) % 7;
  const from = new Date(anchor);
  from.setDate(anchor.getDate() - day);
  const to = new Date(from);
  to.setDate(from.getDate() + 6);
  return { from: localDate(from), to: localDate(to) };
}

function allRange(rows, key = 'd') {
  const dates = rows.map((row) => rowDate(row, key)).filter(Boolean).sort();
  return { from: dates[0] || TODAY, to: dates[dates.length - 1] || TODAY };
}

function getRange(period, customFrom, customTo, rows = [], key = 'd') {
  if (period === 'day' || period === 'today') return { from: TODAY, to: TODAY };
  if (period === 'week') return weekRange();
  if (period === 'month') return currentMonthRange();
  if (period === 'all') return allRange(rows, key);
  return { from: customFrom || TODAY, to: customTo || customFrom || TODAY };
}

function inRange(value, from, to) {
  if (!value) return false;
  return (!from || value >= from) && (!to || value <= to);
}

function normalizeData(data) {
  const masters = data.masters || [];
  const byName = Object.fromEntries(masters.map((master) => [master.name, master]));
  const settings = (data.settings || [])[0] || {};

  return {
    role: data.role || 'unknown',
    me: data.me || '',
    masters,
    byName,
    activeMasters: masters.filter((master) => master.active !== false),
    sales: data.sales || [],
    fines: data.fines || [],
    attendance: data.attendance || [],
    expenses: data.expenses || [],
    debts: data.debts || [],
    debtPayments: data.debt_payments || [],
    settings,
  };
}

function emptyState() {
  return normalizeData({});
}

function MasterView({ data, reload, setError }) {
  const [selectedMaster, setSelectedMaster] = useState(data.me || data.activeMasters[0]?.name || '');
  const [payType, setPayType] = useState('cash');
  const [amount, setAmount] = useState('');
  const [clientCount, setClientCount] = useState(1);
  const [isNewClient, setIsNewClient] = useState(null);
  const [period, setPeriod] = useState('week');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [message, setMessage] = useState('');

  const canPickMaster = data.role === 'admin';
  const masterName = data.role === 'master' ? data.me : selectedMaster;
  const pct = Number(data.byName[masterName]?.pct ?? 40);
  const range = getRange(period, customFrom, customTo, data.sales);
  const masterSales = data.sales.filter((sale) => sale.master === masterName);
  const todaySales = masterSales.filter((sale) => rowDate(sale) === TODAY);
  const visibleSales = masterSales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), range.from, range.to),
  );
  const visibleFines = data.fines.filter((fine) => fine.master === masterName && inRange(rowDate(fine), range.from, range.to));
  const revenue = visibleSales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const fineTotal = visibleFines.reduce((sum, fine) => sum + (Number(fine.amount) || 0), 0);
  const pay = Math.max(0, (revenue * pct) / 100 - fineTotal);
  const attendanceToday = data.attendance.find((item) => item.master === masterName && rowDate(item) === TODAY);
  const shiftStart = data.settings.shift_start || '09:00';

  useEffect(() => {
    if (!masterName && data.activeMasters[0]?.name) setSelectedMaster(data.activeMasters[0].name);
  }, [data.activeMasters, masterName]);

  async function submitSale(event) {
    event.preventDefault();
    setError('');
    setMessage('');

    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) return setError('Введите сумму продажи.');
    if (!masterName) return setError('Сначала выберите мастера.');
    if (isNewClient == null) return setError('Отметьте, клиент новый или постоянный.');

    const payload = {
      master: masterName,
      d: TODAY,
      cash: 0,
      card: 0,
      qr: 0,
      cl: clientCount,
      is_new_client: isNewClient,
      [payType]: numericAmount,
    };

    await callLegacyApi('addSale', payload);
    setAmount('');
    setClientCount(1);
    setIsNewClient(null);
    setMessage(data.role === 'master'
      ? 'Оплата отправлена owner на подтверждение.'
      : 'Продажа сохранена.');
    await reload();
  }

  async function deleteSale(id) {
    await callLegacyApi('delSale', { id });
    await reload();
  }

  async function markArrival() {
    setError('');
    setMessage('');

    const arrived = new Date().toTimeString().slice(0, 5);
    const salonLat = Number(data.settings.salon_lat);
    const salonLng = Number(data.settings.salon_lng);
    const salonRadius = Number(data.settings.salon_radius || 100);

    if (Number.isFinite(salonLat) && Number.isFinite(salonLng) && navigator.geolocation) {
      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 7000 });
        });
        const distance = distanceMeters(
          position.coords.latitude,
          position.coords.longitude,
          salonLat,
          salonLng,
        );
        if (distance > salonRadius) {
          setError(`Вы примерно в ${Math.round(distance)} м от салона. Отметиться можно в радиусе ${salonRadius} м.`);
          return;
        }
      } catch {
        setError('Не удалось получить геолокацию. Разрешите доступ и попробуйте снова.');
        return;
      }
    }

    await callLegacyApi('setAttendance', { master: masterName, d: TODAY, arrived });
    setMessage('Приход отмечен.');
    await reload();
  }

  async function resetArrival() {
    await callLegacyApi('delAttendance', { master: masterName, d: TODAY });
    await reload();
  }

  return (
    <section className="view-grid">
      {canPickMaster ? (
        <div className="card">
          <h2>Кто работает</h2>
          <select value={selectedMaster} onChange={(event) => setSelectedMaster(event.target.value)}>
            {data.activeMasters.map((master) => (
              <option key={master.name} value={master.name}>{master.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="card">
        <h2>Смена сегодня</h2>
        {attendanceToday ? (
          <>
            <p className="big-line">Пришёл в {displayTime(attendanceToday.arrived || attendanceToday.arrived_at)}</p>
            <p className="hint">
              {minutesLate(attendanceToday.arrived || attendanceToday.arrived_at, shiftStart)
                ? `Опоздал на ${minutesLate(attendanceToday.arrived || attendanceToday.arrived_at, shiftStart)} мин`
                : 'Вовремя'}
            </p>
            <button className="btn ghost" type="button" onClick={resetArrival}>Изменить</button>
          </>
        ) : (
          <>
            <button className="btn" type="button" onClick={markArrival} disabled={!masterName}>Я пришёл</button>
            <p className="hint">Смена с {shiftStart}. Если координаты салона заданы, отметка проверяет радиус.</p>
          </>
        )}
      </div>

      <form className="card" onSubmit={submitSale}>
        <h2>Новая продажа</h2>
        <div className="seg">
          {[
            ['cash', 'Наличные'],
            ['card', 'Карта'],
            ['qr', 'QR Paynet'],
          ].map(([value, label]) => (
            <button className={payType === value ? 'on' : ''} key={value} type="button" onClick={() => setPayType(value)}>
              {label}
            </button>
          ))}
        </div>
        <input inputMode="numeric" type="number" placeholder="например, 150000" value={amount} onChange={(event) => setAmount(event.target.value)} />
        <div className="counter">
          <button type="button" onClick={() => setClientCount(Math.max(0, clientCount - 1))}>-</button>
          <strong>{clientCount}</strong>
          <button type="button" onClick={() => setClientCount(clientCount + 1)}>+</button>
        </div>
        <div className="seg">
          <button className={isNewClient === true ? 'on' : ''} type="button" onClick={() => setIsNewClient(true)}>Новый</button>
          <button className={isNewClient === false ? 'on' : ''} type="button" onClick={() => setIsNewClient(false)}>Постоянный</button>
        </div>
        <button className="btn" type="submit">Добавить</button>
        {message ? <p className="success">{message}</p> : null}
      </form>

      <div className="card">
        <h2>Сегодня</h2>
        <Rows
          rows={todaySales}
          empty="Пока нет записей за сегодня."
          render={(sale) => (
            <div className="row" key={sale.id}>
              <div>
                <strong>{money(saleTotal(sale))} сум</strong>
                <span>{sale.cash ? 'Наличные' : sale.card ? 'Карта' : 'QR Paynet'} · клиентов {clients(sale)} · {clientType(sale)}</span>
                <span>Внесено: {displayDateTime(sale.created_at)}</span>
                {isPendingOwnerApproval(sale) ? <span className="approval pending">Ожидает owner</span> : null}
                {isRejectedByOwner(sale) ? <span className="approval rejected">Отклонено owner</span> : null}
              </div>
              {data.role === 'admin' || isPendingOwnerApproval(sale) ? (
                <button className="del" type="button" onClick={() => deleteSale(sale.id)}>×</button>
              ) : null}
            </div>
          )}
        />
      </div>

      <div className="card wide">
        <h2>Мой заработок</h2>
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="hero">{money(pay)} <small>сум к выплате</small></div>
        <div className="tiles">
          <Tile label="Выручка" value={money(revenue)} />
          <Tile label="Мой %" value={`${pct}%`} />
          <Tile label="Штрафы" value={`-${money(fineTotal)}`} danger />
          <Tile label="Клиентов" value={visibleSales.reduce((sum, sale) => sum + clients(sale), 0)} />
          <Tile label="Наличные" value={money(visibleSales.reduce((sum, sale) => sum + (Number(sale.cash) || 0), 0))} />
          <Tile label="Карта" value={money(visibleSales.reduce((sum, sale) => sum + (Number(sale.card) || 0), 0))} />
          <Tile label="QR Paynet" value={money(visibleSales.reduce((sum, sale) => sum + (Number(sale.qr) || 0), 0))} />
        </div>
      </div>
    </section>
  );
}

function AdminView({ data, reload, setError }) {
  const [period, setPeriod] = useState('week');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [fineForm, setFineForm] = useState({ master: data.activeMasters[0]?.name || '', d: TODAY, amount: '' });
  const [settings, setSettings] = useState({
    shift_start: data.settings.shift_start || '09:00',
    salon_lat: data.settings.salon_lat || '',
    salon_lng: data.settings.salon_lng || '',
    salon_radius: data.settings.salon_radius || 100,
  });
  const [message, setMessage] = useState('');
  const range = getRange(period, customFrom, customTo, data.sales);
  const pendingSales = data.sales.filter(isPendingOwnerApproval);
  const sales = data.sales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), range.from, range.to),
  );
  const attendance = data.attendance.filter((item) => inRange(rowDate(item), range.from, range.to));
  const fines = data.fines.filter((fine) => inRange(rowDate(fine), range.from, range.to));
  const revenue = sales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const newClients = sales.filter((sale) => sale.is_new_client === true).reduce((sum, sale) => sum + clients(sale), 0);

  async function saveSettings(event) {
    event.preventDefault();
    await callLegacyApi('setSettings', {
      shift_start: settings.shift_start,
      salon_lat: settings.salon_lat === '' ? null : Number(settings.salon_lat),
      salon_lng: settings.salon_lng === '' ? null : Number(settings.salon_lng),
      salon_radius: Number(settings.salon_radius) || 100,
    });
    setMessage('Настройки сохранены.');
    await reload();
  }

  async function useMyLocation() {
    if (!navigator.geolocation) return setError('Геолокация не поддерживается.');
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 7000 });
    });
    setSettings((current) => ({
      ...current,
      salon_lat: position.coords.latitude,
      salon_lng: position.coords.longitude,
    }));
  }

  async function saveAttendance(master, arrived) {
    if (arrived) await callLegacyApi('setAttendance', { master, d: TODAY, arrived });
    else await callLegacyApi('delAttendance', { master, d: TODAY });
    await reload();
  }

  async function addFine(event) {
    event.preventDefault();
    const amount = Number(fineForm.amount);
    if (!amount || amount <= 0) return setError('Введите сумму штрафа.');
    await callLegacyApi('addFine', { master: fineForm.master, d: fineForm.d || TODAY, amount });
    setFineForm((current) => ({ ...current, amount: '' }));
    setMessage('Штраф добавлен.');
    await reload();
  }

  async function setSaleApproval(id, status) {
    setError('');
    await callLegacyApi('setSaleApproval', { id, status });
    setMessage(status === 'approved' ? 'Оплата подтверждена.' : 'Оплата отклонена.');
    await reload();
  }

  return (
    <section className="view-grid">
      <div className="card wide">
        <h2>Оплаты на подтверждение</h2>
        <Rows
          rows={pendingSales}
          empty="Новых оплат от мастеров на подтверждение нет."
          render={(sale) => (
            <div className="row approval-row" key={sale.id}>
              <div>
                <strong>{sale.master} · {money(saleTotal(sale))} сум</strong>
                <span>
                  {rowDate(sale)} · {sale.cash ? 'Наличные' : sale.card ? 'Карта' : 'QR Paynet'} · клиентов {clients(sale)} · {clientType(sale)}
                </span>
                <span>Внесено мастером: {displayDateTime(sale.created_at)}</span>
              </div>
              <div className="approval-actions">
                <button className="btn approval-button" type="button" onClick={() => setSaleApproval(sale.id, 'approved')}>
                  Подтвердить
                </button>
                <button className="btn ghost approval-button" type="button" onClick={() => setSaleApproval(sale.id, 'rejected')}>
                  Отклонить
                </button>
              </div>
            </div>
          )}
        />
      </div>

      <div className="card wide">
        <h2>Период отчёта</h2>
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="tiles">
          <Tile label="Наличные" value={money(sales.reduce((sum, sale) => sum + (Number(sale.cash) || 0), 0))} />
          <Tile label="Карта" value={money(sales.reduce((sum, sale) => sum + (Number(sale.card) || 0), 0))} />
          <Tile label="QR Paynet" value={money(sales.reduce((sum, sale) => sum + (Number(sale.qr) || 0), 0))} />
          <Tile label="Итого" value={money(revenue)} />
          <Tile label="Новые" value={newClients} />
          <Tile label="Постоянные" value={sales.reduce((sum, sale) => sum + clients(sale), 0) - newClients} />
        </div>
      </div>

      <div className="card wide">
        <h2>Посещаемость сегодня</h2>
        {data.activeMasters.map((master) => {
          const item = data.attendance.find((row) => row.master === master.name && rowDate(row) === TODAY);
          return (
            <div className="row" key={master.name}>
              <div>
                <strong>{master.name}</strong>
                <span>{item ? `пришёл ${displayTime(item.arrived || item.arrived_at)}` : 'нет отметки'}</span>
              </div>
              <input
                type="time"
                defaultValue={displayTime(item?.arrived || item?.arrived_at)}
                onBlur={(event) => saveAttendance(master.name, event.target.value)}
              />
            </div>
          );
        })}
      </div>

      <details className="card collapsible-card">
        <summary>
          <span>Настройки смены и салона</span>
          <span className="summary-action">Открыть</span>
        </summary>
        <form className="collapsible-content" onSubmit={saveSettings}>
          <label>Начало смены<input type="time" value={settings.shift_start} onChange={(event) => setSettings({ ...settings, shift_start: event.target.value })} /></label>
          <label>Широта<input type="number" step="any" value={settings.salon_lat} onChange={(event) => setSettings({ ...settings, salon_lat: event.target.value })} /></label>
          <label>Долгота<input type="number" step="any" value={settings.salon_lng} onChange={(event) => setSettings({ ...settings, salon_lng: event.target.value })} /></label>
          <label>Радиус, м<input type="number" value={settings.salon_radius} onChange={(event) => setSettings({ ...settings, salon_radius: event.target.value })} /></label>
          <button className="btn ghost" type="button" onClick={useMyLocation}>Задать по моему положению</button>
          <button className="btn" type="submit">Сохранить настройки</button>
          {message ? <p className="success">{message}</p> : null}
        </form>
      </details>

      <form className="card" onSubmit={addFine}>
        <h2>Штрафы</h2>
        <select value={fineForm.master} onChange={(event) => setFineForm({ ...fineForm, master: event.target.value })}>
          {data.activeMasters.map((master) => <option key={master.name} value={master.name}>{master.name}</option>)}
        </select>
        <input type="date" value={fineForm.d} onChange={(event) => setFineForm({ ...fineForm, d: event.target.value })} />
        <input inputMode="numeric" type="number" placeholder="50000" value={fineForm.amount} onChange={(event) => setFineForm({ ...fineForm, amount: event.target.value })} />
        <button className="btn" type="submit">Добавить штраф</button>
        <Rows rows={fines} empty="Штрафов за период нет." render={(fine) => (
          <div className="row" key={fine.id}><strong>{fine.master}</strong><span>{rowDate(fine)} · -{money(fine.amount)}</span></div>
        )} />
      </form>

      <div className="card wide">
        <h2>По мастерам</h2>
        {data.activeMasters.map((master) => {
          const rows = sales.filter((sale) => sale.master === master.name);
          const masterRevenue = rows.reduce((sum, sale) => sum + saleTotal(sale), 0);
          const masterFine = fines.filter((fine) => fine.master === master.name).reduce((sum, fine) => sum + (Number(fine.amount) || 0), 0);
          const pay = Math.max(0, (masterRevenue * Number(master.pct || 40)) / 100 - masterFine);
          return (
            <div className="row" key={master.name}>
              <div><strong>{master.name}</strong><span>{money(masterRevenue)} сум · {rows.reduce((sum, sale) => sum + clients(sale), 0)} клиентов</span></div>
              <strong>{money(pay)}</strong>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FinanceView({ data, reload, setError }) {
  const [period, setPeriod] = useState('week');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [tab, setTab] = useState('ishxona');
  const [form, setForm] = useState({ date: TODAY, section: 'ishxona', name: '', qty: '', amount_uzs: '', usd_rate: localStorage.getItem('usdRate') || '12200', minus_from: '' });
  const financeRows = [...data.sales, ...data.expenses];
  const range = getRange(period, customFrom, customTo, financeRows);
  const sales = data.sales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), range.from, range.to),
  );
  const expenses = data.expenses.filter((expense) => inRange(rowDate(expense, 'date'), range.from, range.to));
  const fines = data.fines.filter((fine) => inRange(rowDate(fine), range.from, range.to));
  const revenue = sales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const payouts = data.activeMasters.reduce((sum, master) => {
    const rows = sales.filter((sale) => sale.master === master.name);
    const rev = rows.reduce((total, sale) => total + saleTotal(sale), 0);
    const fine = fines.filter((item) => item.master === master.name).reduce((total, item) => total + (Number(item.amount) || 0), 0);
    return sum + Math.max(0, (rev * Number(master.pct || 40)) / 100 - fine);
  }, 0);
  const salon = revenue - payouts;
  const ishxonaExpenses = expenses.filter((expense) => expense.section === 'ishxona').reduce((sum, expense) => sum + (Number(expense.amount_uzs) || 0), 0);
  const visibleExpenses = expenses.filter((expense) => expense.section === tab);
  const visibleExpenseTotal = visibleExpenses.reduce((sum, expense) => sum + (Number(expense.amount_uzs) || 0), 0);

  async function addExpense(event) {
    event.preventDefault();
    const amount = Number(form.amount_uzs);
    if (!form.name.trim() || !amount) return setError('Введите название и сумму расхода.');
    await callLegacyApi('addExpense', {
      date: form.date || TODAY,
      section: form.section,
      name: form.name.trim(),
      qty: form.qty || null,
      amount_uzs: amount,
      usd_rate: Number(form.usd_rate) || null,
      minus_from: form.section === 'ishxona' ? form.minus_from || null : null,
    });
    if (form.usd_rate) localStorage.setItem('usdRate', form.usd_rate);
    setForm((current) => ({ ...current, name: '', qty: '', amount_uzs: '' }));
    await reload();
  }

  async function deleteExpense(id) {
    await callLegacyApi('delExpense', { id });
    await reload();
  }

  function investment(owner) {
    return data.expenses.reduce((acc, expense) => {
      const amount = Number(expense.amount_uzs) || 0;
      const rate = Number(expense.usd_rate) || 0;
      if (expense.section === owner) acc.invested += amount;
      if (expense.section === 'ishxona' && expense.minus_from === owner) acc.returned += amount;
      if (rate && expense.section === owner) acc.investedUsd += amount / rate;
      if (rate && expense.section === 'ishxona' && expense.minus_from === owner) acc.returnedUsd += amount / rate;
      return acc;
    }, { invested: 0, returned: 0, investedUsd: 0, returnedUsd: 0 });
  }

  return (
    <section className="view-grid">
      <div className="card wide">
        <h2>Финансы</h2>
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="hero">{money(salon - ishxonaExpenses)} <small>сум прибыль</small></div>
        <div className="tiles">
          <Tile label="Выручка" value={money(revenue)} />
          <Tile label="Зарплаты мастеров" value={money(payouts)} danger />
          <Tile label="Остаток салону" value={money(salon)} />
          <Tile label="Расходы" value={money(ishxonaExpenses)} danger />
        </div>
      </div>

      <div className="card wide">
        <h2>Вложения</h2>
        <div className="tiles">
          {['murod', 'jamshid'].map((owner) => {
            const item = investment(owner);
            return (
              <Tile
                key={owner}
                label={owner === 'murod' ? 'Мурод' : 'Жамшид'}
                value={`${money(item.invested - item.returned)} сум`}
                hint={`вложено ${money(item.invested)} · возврат ${money(item.returned)}`}
              />
            );
          })}
        </div>
      </div>

      <div className="card wide">
        <h2>Расходы</h2>
        <div className="seg">
          {[
            ['ishxona', 'Ишхона'],
            ['murod', 'Мурод'],
            ['jamshid', 'Жамшид'],
          ].map(([value, label]) => <button className={tab === value ? 'on' : ''} key={value} type="button" onClick={() => setTab(value)}>{label}</button>)}
        </div>
        <div className="section-total">
          <span>За выбранный период: {visibleExpenses.length} записей</span>
          <strong>{money(visibleExpenseTotal)} сум</strong>
        </div>
        <Rows rows={visibleExpenses} empty="Расходов за период нет." render={(expense) => (
          <div className="row" key={expense.id}>
            <div><strong>{expense.name}</strong><span>{rowDate(expense, 'date')} · {expense.minus_from ? `минус ${expense.minus_from}` : expense.section}</span></div>
            <div><strong>{money(expense.amount_uzs)}</strong><button className="del" type="button" onClick={() => deleteExpense(expense.id)}>×</button></div>
          </div>
        )} />
      </div>

      <form className="card" onSubmit={addExpense}>
        <h2>Добавить расход</h2>
        <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
        <select value={form.section} onChange={(event) => setForm({ ...form, section: event.target.value })}>
          <option value="ishxona">Ишхона</option>
          <option value="murod">Мурод</option>
          <option value="jamshid">Жамшид</option>
        </select>
        <input placeholder="Наименование" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input placeholder="Количество" value={form.qty} onChange={(event) => setForm({ ...form, qty: event.target.value })} />
        <input inputMode="numeric" type="number" placeholder="Сумма" value={form.amount_uzs} onChange={(event) => setForm({ ...form, amount_uzs: event.target.value })} />
        <input inputMode="numeric" type="number" placeholder="Курс USD" value={form.usd_rate} onChange={(event) => setForm({ ...form, usd_rate: event.target.value })} />
        {form.section === 'ishxona' ? (
          <select value={form.minus_from} onChange={(event) => setForm({ ...form, minus_from: event.target.value })}>
            <option value="">— нет —</option>
            <option value="murod">Мурод</option>
            <option value="jamshid">Жамшид</option>
          </select>
        ) : null}
        <button className="btn" type="submit">Добавить расход</button>
      </form>
    </section>
  );
}

function DebtsView({ data, reload, setError }) {
  const [showClosed, setShowClosed] = useState(false);
  const [allMonths, setAllMonths] = useState(false);
  const [form, setForm] = useState({ counterparty: '', direction: 'i_owe', amount: '', currency: 'UZS', start_date: TODAY });
  const [payments, setPayments] = useState({});
  const activeDebts = data.debts.filter((debt) => !debt.is_closed);
  const closedDebts = data.debts.filter((debt) => debt.is_closed);
  const months = [...new Set(data.debtPayments.map((payment) => String(payment.date).slice(0, 7)))].sort();
  const visibleMonths = allMonths ? months : months.slice(-4);

  function paid(debtId) {
    return data.debtPayments.filter((payment) => String(payment.debt_id) === String(debtId)).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  }

  async function addDebt(event) {
    event.preventDefault();
    const amount = Number(form.amount);
    if (!form.counterparty.trim() || !amount) return setError('Введите контрагента и сумму долга.');
    await callLegacyApi('addDebt', { ...form, amount, start_date: form.start_date || TODAY });
    setForm({ counterparty: '', direction: 'i_owe', amount: '', currency: 'UZS', start_date: TODAY });
    await reload();
  }

  async function addPayment(event, debt) {
    event.preventDefault();
    const payment = payments[debt.id] || {};
    const amount = Number(payment.amount);
    if (!amount) return setError('Введите сумму платежа.');
    await callLegacyApi('addDebtPayment', { debt_id: debt.id, date: payment.date || TODAY, amount });
    if (amount >= Number(debt.amount) - paid(debt.id) && !debt.is_closed) {
      await callLegacyApi('setDebtClosed', { id: debt.id, is_closed: true });
    }
    setPayments((current) => ({ ...current, [debt.id]: { date: TODAY, amount: '' } }));
    await reload();
  }

  async function deletePayment(id) {
    await callLegacyApi('delDebtPayment', { id });
    await reload();
  }

  async function toggleDebt(debt) {
    await callLegacyApi('setDebtClosed', { id: debt.id, is_closed: !debt.is_closed });
    await reload();
  }

  async function deleteDebt(id) {
    await callLegacyApi('delDebt', { id });
    await reload();
  }

  const renderDebt = (debt) => {
    const debtPayments = data.debtPayments.filter((payment) => String(payment.debt_id) === String(debt.id));
    const remaining = Number(debt.amount) - paid(debt.id);
    const paymentForm = payments[debt.id] || { date: TODAY, amount: '' };
    return (
      <article className="debt-card" key={debt.id}>
        <div className="row">
          <div><strong>{debt.counterparty}</strong><span>{debt.direction === 'i_owe' ? 'я должен' : 'мне должны'} · {debt.currency}</span></div>
          <strong className={remaining > 0 ? 'danger' : 'success'}>{money(remaining)}</strong>
        </div>
        <Rows rows={debtPayments} empty="Платежей нет." render={(payment) => (
          <div className="row compact" key={payment.id}><span>{payment.date}</span><strong>{money(payment.amount)}</strong><button className="del" type="button" onClick={() => deletePayment(payment.id)}>×</button></div>
        )} />
        <form className="inline-form" onSubmit={(event) => addPayment(event, debt)}>
          <input type="date" value={paymentForm.date || TODAY} onChange={(event) => setPayments({ ...payments, [debt.id]: { ...paymentForm, date: event.target.value } })} />
          <input inputMode="numeric" type="number" placeholder="Сумма" value={paymentForm.amount || ''} onChange={(event) => setPayments({ ...payments, [debt.id]: { ...paymentForm, amount: event.target.value } })} />
          <button className="btn ghost" type="submit">Платёж</button>
        </form>
        <div className="actions">
          <button className="btn ghost" type="button" onClick={() => toggleDebt(debt)}>{debt.is_closed ? 'Открыть' : 'Закрыть'}</button>
          {debt.is_closed ? <button className="btn danger-btn" type="button" onClick={() => deleteDebt(debt.id)}>Удалить</button> : null}
        </div>
      </article>
    );
  };

  return (
    <section className="view-grid">
      <div className="card wide">
        <h2>Долги по месяцам</h2>
        <div className="seg">
          <button className={showClosed ? 'on' : ''} type="button" onClick={() => setShowClosed(!showClosed)}>Погашенные</button>
          <button className={allMonths ? 'on' : ''} type="button" onClick={() => setAllMonths(!allMonths)}>Все месяцы</button>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Кому</th>{visibleMonths.map((month) => <th key={month}>{month}</th>)}<th>Остаток</th></tr></thead>
            <tbody>
              {data.debts.filter((debt) => showClosed || !debt.is_closed).map((debt) => (
                <tr key={debt.id}>
                  <td>{debt.counterparty}</td>
                  {visibleMonths.map((month) => <td key={month}>{money(data.debtPayments.filter((payment) => String(payment.debt_id) === String(debt.id) && String(payment.date).startsWith(month)).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0))}</td>)}
                  <td>{money(Number(debt.amount) - paid(debt.id))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <form className="card" onSubmit={addDebt}>
        <h2>Добавить долг</h2>
        <input placeholder="Кто / кому" value={form.counterparty} onChange={(event) => setForm({ ...form, counterparty: event.target.value })} />
        <select value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value })}>
          <option value="i_owe">Я должен</option>
          <option value="owed_to_me">Мне должны</option>
        </select>
        <select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
          <option value="UZS">UZS</option>
          <option value="USD">USD</option>
        </select>
        <input inputMode="numeric" type="number" placeholder="Сумма" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
        <input type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} />
        <button className="btn" type="submit">Добавить долг</button>
      </form>

      <div className="card wide">
        <h2>Активные долги</h2>
        <Rows rows={activeDebts} empty="Долгов пока нет." render={renderDebt} />
        {showClosed ? <><h2>Погашенные</h2><Rows rows={closedDebts} empty="Погашенных долгов нет." render={renderDebt} /></> : null}
      </div>
    </section>
  );
}

function PeriodPicker({ period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo }) {
  return (
    <>
      <div className="seg">
        {[
          ['day', 'День'],
          ['week', 'Неделя'],
          ['month', 'Месяц'],
          ['all', 'Всё'],
          ['custom', 'Период'],
        ].map(([value, label]) => (
          <button className={period === value ? 'on' : ''} key={value} type="button" onClick={() => setPeriod(value)}>
            {label}
          </button>
        ))}
      </div>
      {period === 'custom' ? (
        <div className="date-row">
          <input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} />
          <input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} />
        </div>
      ) : null}
    </>
  );
}

function Tile({ label, value, hint, danger }) {
  return (
    <div className={`tile ${danger ? 'danger' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function Rows({ rows, empty, render }) {
  if (!rows.length) return <p className="hint">{empty}</p>;
  return <div className="rows">{rows.map(render)}</div>;
}

const TELEGRAM_BOT_USERNAME = 'Maestro_uzbot';
const TELEGRAM_BOT_LINK = `https://t.me/${TELEGRAM_BOT_USERNAME}`;
const TELEGRAM_WIDGET_DOMAIN = 'maestro-pied-two.vercel.app';

function LoginGate({ error }) {
  const [showWidget, setShowWidget] = useState(false);

  useEffect(() => {
    if (!showWidget) return;

    const box = document.getElementById('tgLoginBox');
    if (!box || box.dataset.ready) return;

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', TELEGRAM_BOT_USERNAME);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '12');
    script.setAttribute('data-auth-url', `https://${TELEGRAM_WIDGET_DOMAIN}/`);
    script.setAttribute('data-request-access', 'write');
    box.appendChild(script);
    box.dataset.ready = '1';
  }, [showWidget]);

  return (
    <main className="login-gate">
      <div className="login-card">
        <img src="/icons/icon-192.png" alt="Maestro" />
        <h1>Maestro</h1>
        <p>Откройте приложение через Telegram, чтобы войти в учёт салона.</p>
        <a className="btn login-primary" href={TELEGRAM_BOT_LINK} rel="noreferrer" target="_blank">
          Открыть в Telegram
        </a>
        <button className="btn ghost" type="button" onClick={() => setShowWidget(true)}>
          Войти на сайте через Telegram
        </button>
        {showWidget ? <div id="tgLoginBox" /> : null}
        <div className="domain-help">
          <strong>Если появляется Bot domain invalid</strong>
          <span>В BotFather для @{TELEGRAM_BOT_USERNAME} нужно указать домен:</span>
          <code>{TELEGRAM_WIDGET_DOMAIN}</code>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>
    </main>
  );
}

export default function App() {
  const [data, setData] = useState(emptyState);
  const [view, setView] = useState('master');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [loginRequired, setLoginRequired] = useState(false);

  async function load() {
    setIsLoading(true);
    setError('');

    try {
      captureTelegramRedirectAuth();

      if (needsTelegramLogin()) {
        setLoginRequired(true);
        return;
      }

      const result = await callLegacyApi('load');
      const normalized = normalizeData(result);
      setData(normalized);
      setLoginRequired(false);
      setView(normalized.role === 'admin' ? 'admin' : 'master');
    } catch (loadError) {
      setError(loadError.message || 'Не удалось загрузить данные.');
      if (String(loadError.message).includes('unauthorized')) setLoginRequired(true);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    load();
  }, []);

  const availableViews = useMemo(() => {
    if (data.role === 'admin') return ['master', 'admin', 'finance', 'debts'];
    if (data.role === 'master') return ['master'];
    return [];
  }, [data.role]);

  if (loginRequired) return <LoginGate error={error} />;

  const CurrentView = {
    master: MasterView,
    admin: AdminView,
    finance: FinanceView,
    debts: DebtsView,
  }[view] || MasterView;

  return (
    <main className="app">
      <div className="pole" />
      <header className="topbar">
        <div className="brand">
          <div className="mark">M</div>
          <div>
            <h1>Maestro</h1>
            <p>{isLoading ? 'загрузка...' : data.role === 'master' && data.me ? `${data.me} · ${data.byName[data.me]?.pct || 40}%` : getTelegramFirstName() ? `привет, ${getTelegramFirstName()}` : 'учёт салона'}</p>
          </div>
        </div>
        <button
          className="logout"
          type="button"
          onClick={() => {
            clearWidgetAuth();
            window.location.reload();
          }}
        >
          Выйти
        </button>
      </header>

      {availableViews.length ? (
        <nav className="seg nav">
          {[
            ['master', 'Мастер'],
            ['admin', 'Админ'],
            ['finance', 'Финансы'],
            ['debts', 'Долги'],
          ].filter(([id]) => availableViews.includes(id)).map(([id, label]) => (
            <button className={view === id ? 'on' : ''} key={id} type="button" onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </nav>
      ) : null}

      {error && !loginRequired ? <div className="notice error">{error}</div> : null}
      {isLoading ? <div className="notice">Загрузка данных...</div> : <CurrentView data={data} reload={load} setError={setError} />}

      <footer>Данные сохраняются в облаке (Supabase). <span>{APP_VERSION}</span></footer>
    </main>
  );
}
