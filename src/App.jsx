import { useEffect, useMemo, useState } from 'react';
import {
  callLegacyApi,
  captureTelegramOAuthCode,
  captureTelegramRedirectAuth,
  getTelegramFirstName,
  needsTelegramLogin,
  startTelegramOAuthLogin,
} from './lib/legacyApi.js';
import { saleClientsCount } from './utils/calculations.js';

const APP_VERSION = 'debts-dashboard-v2';
const TODAY = localDate();
const THEMES = {
  brass: {
    name: 'Латунь',
    light: { brass: '#A9742E', 'brass-soft': '#F0E4D0', bg: '#F3F0EB', surface: '#FFFFFF', 'surface-2': '#FAF8F5', ink: '#181613', muted: '#7A736B', line: '#E7E2DA' },
    dark: { brass: '#D9A75A', 'brass-soft': '#3A3326', bg: '#15140F', surface: '#211F1A', 'surface-2': '#1A1915', ink: '#F2EEE7', muted: '#9A9388', line: '#33302A' },
  },
  emerald: {
    name: 'Изумруд',
    light: { bg: '#F1F5F2', surface: '#FFFFFF', 'surface-2': '#F6FAF7', ink: '#14201A', muted: '#6B7A72', line: '#DDE8E1', brass: '#1E7A52', 'brass-soft': '#D9EFE3' },
    dark: { bg: '#0E1714', surface: '#16211C', 'surface-2': '#121B17', ink: '#EAF3EE', muted: '#8AA398', line: '#29372F', brass: '#3FB37B', 'brass-soft': '#1C3329' },
  },
  midnight: {
    name: 'Полночь',
    light: { bg: '#F1F2F8', surface: '#FFFFFF', 'surface-2': '#F6F7FC', ink: '#15172A', muted: '#6E7290', line: '#E1E3F0', brass: '#3B43B5', 'brass-soft': '#E2E4FA' },
    dark: { bg: '#0F1020', surface: '#1A1B2E', 'surface-2': '#151628', ink: '#ECEDF7', muted: '#9498BE', line: '#2C2E47', brass: '#7C84F0', 'brass-soft': '#262A52' },
  },
  barber: {
    name: 'Барбер',
    light: { bg: '#F4F2EE', surface: '#FFFFFF', 'surface-2': '#F9F7F3', ink: '#16202E', muted: '#6F7682', line: '#E4E2DC', brass: '#1F3A66', 'brass-soft': '#DBE3F0' },
    dark: { bg: '#101620', surface: '#1A2230', 'surface-2': '#151B26', ink: '#ECF0F6', muted: '#8A93A3', line: '#2A3340', brass: '#5B86C9', 'brass-soft': '#213048' },
  },
};

function localDate(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function money(value) {
  return Math.round(Number(value) || 0).toLocaleString('ru-RU');
}

function usdMoney(value) {
  return `$${money(value)}`;
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function formatDigits(value) {
  const digits = digitsOnly(value);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
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

function newestFirst(left, right) {
  const leftKey = `${rowDate(left)}T${left.created_at || left.arrived_at || left.arrived || ''}`;
  const rightKey = `${rowDate(right)}T${right.created_at || right.arrived_at || right.arrived || ''}`;
  return rightKey.localeCompare(leftKey);
}

function clients(sale) {
  return saleClientsCount(sale);
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

function displayDate(value) {
  if (!value) return 'дата не выбрана';
  const [year, month, day] = String(value).split('-');
  return year && month && day ? `${day}.${month}.${year}` : String(value);
}

function displayRange(range) {
  if (!range?.from && !range?.to) return 'период не выбран';
  if (range.from === range.to || !range.to) return displayDate(range.from);
  return `${displayDate(range.from)}–${displayDate(range.to)}`;
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

function recentRecordCanBeDeleted(recordDate, days) {
  const cutoff = new Date(`${TODAY}T12:00:00`);
  cutoff.setDate(cutoff.getDate() - days);
  return Boolean(recordDate) && recordDate >= localDate(cutoff);
}

const recentFineCanBeDeleted = (date) => recentRecordCanBeDeleted(date, 7);
const recentSaleCanBeDeleted = (date) => recentRecordCanBeDeleted(date, 2);

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

function MoneyInput({ value, onChange, ...props }) {
  return (
    <input
      {...props}
      inputMode="numeric"
      type="text"
      value={formatDigits(value)}
      onChange={(event) => onChange(digitsOnly(event.target.value))}
    />
  );
}

function MasterView({ data, reload, setError }) {
  const [selectedMaster, setSelectedMaster] = useState(data.me || data.activeMasters[0]?.name || '');
  const [payType, setPayType] = useState(null);
  const [amount, setAmount] = useState('');
  const [clientCount, setClientCount] = useState(1);
  const [isNewClient, setIsNewClient] = useState(null);
  const [period, setPeriod] = useState('day');
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
    if (!payType) return setError('Выберите способ оплаты.');
    if (!numericAmount || numericAmount <= 0) return setError('Введите сумму продажи.');
    if (!masterName) return setError('Сначала выберите мастера.');
    if (clientCount > 0 && isNewClient == null) return setError('Отметьте, клиент новый или постоянный.');

    const payload = {
      master: masterName,
      d: TODAY,
      cash: 0,
      card: 0,
      qr: 0,
      cl: clientCount,
      clients_count: clientCount,
      is_new_client: clientCount === 0 ? null : isNewClient,
      [payType]: numericAmount,
    };

    await callLegacyApi('addSale', payload);
    setPayType(null);
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
        <SectionHeading label="Смена сегодня" range={{ from: TODAY, to: TODAY }} />
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
        <div className="pay-types">
          {[
            ['cash', 'Наличные'],
            ['card', 'Карта'],
            ['qr', 'QR Paynet'],
          ].map(([value, label]) => (
            <button
              aria-pressed={payType === value}
              className={`pay-type ${value} ${payType === value ? 'on' : ''}`}
              key={value}
              type="button"
              onClick={() => setPayType(value)}
            >
              <span className="payment-dot" />{label}
            </button>
          ))}
        </div>
        <MoneyInput
          placeholder="например, 150 000"
          value={amount}
          onChange={setAmount}
        />
        <div className="counter">
          <button type="button" onClick={() => setClientCount(Math.max(0, clientCount - 1))}>-</button>
          <strong>{clientCount}</strong>
          <button type="button" onClick={() => setClientCount(clientCount + 1)}>+</button>
        </div>
        <div className="seg">
          <button className={isNewClient === true ? 'on' : ''} type="button" onClick={() => setIsNewClient(true)}>Новый</button>
          <button className={isNewClient === false ? 'on' : ''} type="button" onClick={() => setIsNewClient(false)}>Постоянный</button>
        </div>
        {clientCount === 0 ? <p className="hint">Продажа сохранится в выручке, но не увеличит число клиентов.</p> : null}
        <button className="btn" type="submit">Добавить</button>
        {message ? <p className="success">{message}</p> : null}
      </form>

      <div className="card">
        <SectionHeading label="Сегодня" range={{ from: TODAY, to: TODAY }} />
        <Rows
          rows={[...todaySales].sort(newestFirst)}
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
        <SectionHeading label="Мой заработок" range={range} />
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
  const [period, setPeriod] = useState('day');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [message, setMessage] = useState('');
  const range = getRange(period, customFrom, customTo, data.sales);
  const pendingSales = data.sales.filter(isPendingOwnerApproval);
  const sales = data.sales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), range.from, range.to),
  );
  const fines = data.fines.filter((fine) => inRange(rowDate(fine), range.from, range.to));
  const revenue = sales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const newClients = sales.filter((sale) => sale.is_new_client === true).reduce((sum, sale) => sum + clients(sale), 0);
  const masterSummaries = data.activeMasters.map((master) => {
    const rows = sales.filter((sale) => sale.master === master.name);
    const masterRevenue = rows.reduce((sum, sale) => sum + saleTotal(sale), 0);
    const masterFine = fines.filter((fine) => fine.master === master.name).reduce((sum, fine) => sum + (Number(fine.amount) || 0), 0);
    return { master, rows, revenue: masterRevenue, pay: Math.max(0, masterRevenue * Number(master.pct || 40) / 100 - masterFine) };
  });
  const totalMasterPayout = masterSummaries.reduce((sum, item) => sum + item.pay, 0);
  const salonRemainder = revenue - totalMasterPayout;

  async function setSaleApproval(id, status) {
    setError('');
    await callLegacyApi('setSaleApproval', { id, status });
    setMessage(status === 'approved' ? 'Оплата подтверждена.' : 'Оплата отклонена.');
    await reload();
  }

  async function deleteDetailedSale(sale) {
    if (!recentSaleCanBeDeleted(rowDate(sale))) return setError('Можно удалять только продажи не старше 2 дней.');
    if (!confirm(`Удалить продажу ${sale.master} на ${money(saleTotal(sale))} сум?`)) return;
    await callLegacyApi('delSale', { id: sale.id });
    setMessage('Продажа удалена.');
    await reload();
  }

  return (
    <section className="view-grid">
      <div className="card wide">
        <h2>Оплаты на подтверждение</h2>
        <Rows
          rows={[...pendingSales].sort(newestFirst)}
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
        <SectionHeading label="Период отчёта" range={range} />
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="tiles">
          <Tile label="Итого" value={money(revenue)} tone="total" />
          <Tile label="Остаток салону" value={money(salonRemainder)} tone="salon" />
          <Tile label="Наличные" value={money(sales.reduce((sum, sale) => sum + (Number(sale.cash) || 0), 0))} />
          <Tile label="Карта" value={money(sales.reduce((sum, sale) => sum + (Number(sale.card) || 0), 0))} />
          <Tile label="QR Paynet" value={money(sales.reduce((sum, sale) => sum + (Number(sale.qr) || 0), 0))} />
          <Tile label="Новые" value={newClients} />
          <Tile label="Постоянные" value={sales.reduce((sum, sale) => sum + clients(sale), 0) - newClients} />
        </div>
      </div>

      <div className="card wide">
        <h2>Выручка по дням</h2>
        <RevenueChart sales={sales} from={range.from} to={range.to} />
      </div>

      <div className="card wide">
        <h2>По мастерам</h2>
        {masterSummaries.map(({ master, rows, revenue: masterRevenue, pay }) => (
          <div className="row" key={master.name}>
            <div><strong>{master.name}</strong><span>{money(masterRevenue)} сум · {rows.reduce((sum, sale) => sum + clients(sale), 0)} клиентов</span></div>
            <strong>{money(pay)}</strong>
          </div>
        ))}
        <div className="payout-total"><span>Итого выплатить мастерам</span><strong>{money(totalMasterPayout)} сум</strong></div>
      </div>

      <div className="card wide detailed-report-card">
        <SectionHeading label="Детальный отчёт по мастерам" range={range} />
        <Rows
          rows={[...sales].sort((left, right) => (
            String(right.created_at || rowDate(right)).localeCompare(String(left.created_at || rowDate(left)))
          ))}
          empty="За выбранный период продаж нет."
          render={(sale) => {
            const master = data.byName[sale.master];
            const amount = saleTotal(sale);
            const masterEarning = amount * Number(master?.pct || 40) / 100;
            const payment = sale.cash ? 'Наличные' : sale.card ? 'Карта' : 'QR Paynet';
            const canDelete = recentSaleCanBeDeleted(rowDate(sale));
            return (
              <div className="row detailed-sale" key={sale.id}>
                <div>
                  <strong>{sale.master}</strong>
                  <span>{displayDateTime(sale.created_at)} · {payment}</span>
                  <span>{clientType(sale)} · клиентов: {clients(sale)}</span>
                </div>
                <div className="detailed-sale-amounts">
                  <strong>{money(amount)} сум</strong>
                  <span>мастеру: {money(masterEarning)} сум</span>
                  <button className="del detailed-sale-delete" disabled={!canDelete} title={canDelete ? 'Удалить продажу' : 'Срок удаления 2 дня истёк'} type="button" onClick={() => deleteDetailedSale(sale)}>×</button>
                </div>
              </div>
            );
          }}
        />
      </div>
    </section>
  );
}

function AttendanceView({ data, reload, setError }) {
  const [period, setPeriod] = useState('day');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [fineForm, setFineForm] = useState({
    master: data.activeMasters[0]?.name || '',
    d: TODAY,
    amount: '',
  });
  const [settings, setSettings] = useState({
    shift_start: data.settings.shift_start || '09:00',
    salon_lat: data.settings.salon_lat || '',
    salon_lng: data.settings.salon_lng || '',
    salon_radius: data.settings.salon_radius || 100,
  });
  const [message, setMessage] = useState('');
  const [savingFineKey, setSavingFineKey] = useState('');
  const range = getRange(period, customFrom, customTo, data.attendance);
  const filteredAttendance = data.attendance
    .filter((item) => inRange(rowDate(item), range.from, range.to))
    .sort(newestFirst);
  const attendanceRows = period === 'day'
    ? data.activeMasters.map((master) => (
        data.attendance.find((item) => item.master === master.name && rowDate(item) === TODAY)
        || { master: master.name, d: TODAY, arrived: '' }
      ))
    : filteredAttendance;
  const filteredFines = data.fines
    .filter((fine) => inRange(rowDate(fine), range.from, range.to))
    .sort(newestFirst);
  const shiftStart = settings.shift_start || '09:00';

  async function saveSettings(event) {
    event.preventDefault();
    setError('');
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
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 7000 });
      });
      setSettings((current) => ({
        ...current,
        salon_lat: position.coords.latitude,
        salon_lng: position.coords.longitude,
      }));
    } catch {
      setError('Не удалось получить геолокацию.');
    }
  }

  async function saveAttendance(master, date, arrived) {
    setError('');
    if (arrived) await callLegacyApi('setAttendance', { master, d: date, arrived });
    else await callLegacyApi('delAttendance', { master, d: date });
    await reload();
  }

  async function createFine(master, date, amount) {
    setError('');
    setMessage('');
    await callLegacyApi('addFine', { master, d: date || TODAY, amount });
    setMessage(`Штраф ${money(amount)} сум выставлен: ${master}.`);
    await reload();
  }

  async function addFine(event) {
    event.preventDefault();
    const amount = Number(fineForm.amount);
    if (!amount || amount <= 0) return setError('Введите сумму штрафа.');
    await createFine(fineForm.master, fineForm.d, amount);
    setFineForm((current) => ({ ...current, amount: '' }));
  }

  async function addLateFine(item) {
    const key = `${item.master}-${rowDate(item)}`;
    setSavingFineKey(key);
    try {
      await createFine(item.master, rowDate(item), 50000);
    } finally {
      setSavingFineKey('');
    }
  }

  async function deleteFine(fine) {
    if (!recentFineCanBeDeleted(rowDate(fine))) {
      setError('Можно удалять только штрафы не старше 7 дней.');
      return;
    }
    if (!confirm(`Удалить штраф ${fine.master} на ${money(fine.amount)} сум?`)) return;
    setError('');
    await callLegacyApi('delFine', { id: fine.id });
    setMessage('Штраф удалён.');
    await reload();
  }

  return (
    <section className="view-grid">
      <div className="card wide">
        <SectionHeading label="Посещаемость" range={range} />
        <PeriodPicker
          period={period}
          setPeriod={setPeriod}
          customFrom={customFrom}
          setCustomFrom={setCustomFrom}
          customTo={customTo}
          setCustomTo={setCustomTo}
        />
        <div className="attendance-list">
          {attendanceRows.length ? attendanceRows.map((item) => {
            const arrived = displayTime(item.arrived || item.arrived_at);
            const lateBy = arrived ? minutesLate(arrived, shiftStart) : 0;
            const status = !arrived ? 'missing' : lateBy > 0 ? 'late' : 'on-time';
            const fineKey = `${item.master}-${rowDate(item)}`;
            const quickFineExists = data.fines.some((fine) => (
              fine.master === item.master
              && rowDate(fine) === rowDate(item)
              && Number(fine.amount) === 50000
            ));

            return (
              <div className={`attendance-row ${status}`} key={`${item.master}-${rowDate(item)}`}>
                <div className="attendance-person">
                  <strong>{item.master}</strong>
                  <span>{displayDate(rowDate(item))}</span>
                  <span>
                    {!arrived
                      ? 'нет отметки'
                      : lateBy > 0
                        ? `опоздал на ${lateBy} мин`
                        : 'пришёл вовремя'}
                  </span>
                </div>
                <div className="attendance-actions">
                  <input
                    aria-label={`Время прихода ${item.master} ${displayDate(rowDate(item))}`}
                    type="time"
                    defaultValue={arrived}
                    onBlur={(event) => saveAttendance(item.master, rowDate(item), event.target.value)}
                  />
                  {status === 'late' ? (
                    <button
                      className="fine-button"
                      disabled={quickFineExists || savingFineKey === fineKey}
                      title="Автоматически выставить штраф 50 000 сум"
                      type="button"
                      onClick={() => addLateFine(item)}
                    >
                      {quickFineExists ? 'Штраф выставлен' : savingFineKey === fineKey ? 'Сохраняю…' : 'Штраф'}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          }) : <p className="hint">За выбранный период отметок нет.</p>}
        </div>
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
        </form>
      </details>

      <form className="card" onSubmit={addFine}>
        <h2>Штрафы</h2>
        <select value={fineForm.master} onChange={(event) => setFineForm({ ...fineForm, master: event.target.value })}>
          {data.activeMasters.map((master) => <option key={master.name} value={master.name}>{master.name}</option>)}
        </select>
        <input type="date" value={fineForm.d} onChange={(event) => setFineForm({ ...fineForm, d: event.target.value })} />
        <MoneyInput placeholder="например, 50 000" value={fineForm.amount} onChange={(amount) => setFineForm({ ...fineForm, amount })} />
        <button className="btn" type="submit">Добавить штраф</button>
        <Rows rows={filteredFines} empty="Штрафов за период нет." render={(fine) => {
          const canDelete = recentFineCanBeDeleted(rowDate(fine));
          return (
            <div className="row fine-row" key={fine.id}>
              <div>
                <strong>{fine.master}</strong>
                <span>{displayDate(rowDate(fine))} · −{money(fine.amount)} сум</span>
              </div>
              <button
                className="del"
                disabled={!canDelete}
                title={canDelete ? 'Удалить штраф' : 'Срок удаления 7 дней истёк'}
                type="button"
                onClick={() => deleteFine(fine)}
              >
                ×
              </button>
            </div>
          );
        }} />
        {message ? <p className="success">{message}</p> : null}
      </form>
    </section>
  );
}

function FinanceView({ data, reload, setError }) {
  const [period, setPeriod] = useState('day');
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
  const visibleExpenses = expenses.filter((expense) => expense.section === tab).sort(newestFirst);
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

  function sectionExpense(section) {
    return data.expenses
      .filter((expense) => expense.section === section)
      .reduce((totals, expense) => {
        const amount = Number(expense.amount_uzs) || 0;
        const rate = Number(expense.usd_rate) || 0;
        totals.uzs += amount;
        if (rate) totals.usd += amount / rate;
        return totals;
      }, { uzs: 0, usd: 0 });
  }

  return (
    <section className="view-grid">
      <div className="card wide">
        <SectionHeading label="Финансы" range={range} />
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="hero profit-value">{money(salon - ishxonaExpenses)} <small>сум прибыль</small></div>
        <div className="tiles">
          <Tile label="Выручка" value={money(revenue)} />
          <Tile label="Зарплаты мастеров" value={money(payouts)} />
          <Tile label="Остаток салону" value={money(salon)} tone="salon" />
          <Tile label="Расходы" value={money(ishxonaExpenses)} danger />
        </div>
      </div>

      <div className="card wide">
        <h2>Вложения</h2>
        <div className="tiles">
          {['murod', 'jamshid'].map((owner) => {
            const item = investment(owner);
            const netUzs = item.invested - item.returned;
            const netUsd = item.investedUsd - item.returnedUsd;
            return (
              <Tile
                key={owner}
                label={owner === 'murod' ? 'Мурод' : 'Жамшид'}
                value={usdMoney(netUsd)}
                secondary={`${money(netUzs)} сум`}
                hint={`вложено ${usdMoney(item.investedUsd)} · возврат ${usdMoney(item.returnedUsd)}`}
              />
            );
          })}
          {(() => {
            const item = sectionExpense('ishxona');
            return (
              <Tile
                label="Расходы Ишхоны"
                value={usdMoney(item.usd)}
                secondary={`${money(item.uzs)} сум`}
                hint={`расходы ${usdMoney(item.usd)}`}
              />
            );
          })()}
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
        <MoneyInput placeholder="Сумма" value={form.amount_uzs} onChange={(amount_uzs) => setForm({ ...form, amount_uzs })} />
        <MoneyInput placeholder="Курс USD" value={form.usd_rate} onChange={(usd_rate) => setForm({ ...form, usd_rate })} />
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

function RevenueChart({ sales, from, to }) {
  const [selectedDay, setSelectedDay] = useState(null);
  const days = [];
  const cursor = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);

  while (cursor <= end && days.length < 370) {
    days.push(localDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const totals = Object.fromEntries(days.map((day) => [day, { revenue: 0, clients: 0 }]));
  sales.forEach((sale) => {
    const day = rowDate(sale);
    if (day in totals) {
      totals[day].revenue += saleTotal(sale);
      totals[day].clients += clients(sale);
    }
  });

  const values = days.map((day) => totals[day].revenue);
  const max = Math.max(1, ...values);
  const barWidth = Math.max(14, Math.min(38, Math.floor(480 / Math.max(1, days.length))));
  const gap = 6;
  const width = Math.max(170, days.length * (barWidth + gap) + 10);
  const labelEvery = Math.max(1, Math.ceil(days.length / 10));
  const selectedIndex = days.indexOf(selectedDay);
  const selectedValue = selectedIndex >= 0 ? values[selectedIndex] : 0;
  const selectedHeight = Math.round((selectedValue / max) * 100);
  const selectedCenter = selectedIndex >= 0
    ? 10 + selectedIndex * (barWidth + gap) + barWidth / 2
    : 0;
  const tooltipWidth = 150;
  const tooltipX = Math.max(4, Math.min(width - tooltipWidth - 4, selectedCenter - tooltipWidth / 2));
  const tooltipY = Math.max(2, 120 - selectedHeight - 40);

  return (
    <div className="chart" aria-label="Выручка по дням">
      <svg height="150" viewBox={`0 0 ${width} 150`} width={width}>
        {days.map((day, index) => {
          const height = Math.round((values[index] / max) * 100);
          const x = 10 + index * (barWidth + gap);
          const isSelected = selectedDay === day;
          return (
            <g
              aria-label={`${displayDate(day)}: ${totals[day].clients} клиентов, выручка ${money(totals[day].revenue)} сум`}
              className={`chart-bar ${isSelected ? 'selected' : ''}`}
              key={day}
              onClick={() => setSelectedDay((current) => current === day ? null : day)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelectedDay((current) => current === day ? null : day);
                }
              }}
              role="button"
              tabIndex="0"
            >
              <rect
                fill="var(--brass)"
                height={height}
                opacity={values[index] ? 0.95 : 0.18}
                rx="3"
                stroke={isSelected ? 'var(--ink)' : 'none'}
                strokeWidth={isSelected ? 2 : 0}
                width={barWidth}
                x={x}
                y={120 - height}
              />
              <rect fill="transparent" height="120" width={barWidth + gap} x={x - gap / 2} y="0" />
              {(days.length <= 14 || index % labelEvery === 0) ? (
                <text fill="var(--muted)" fontSize="9" textAnchor="middle" x={x + barWidth / 2} y="134">
                  {day.slice(8, 10)}.{day.slice(5, 7)}
                </text>
              ) : null}
            </g>
          );
        })}
        {selectedIndex >= 0 ? (
          <g className="chart-tooltip" pointerEvents="none">
            <rect
              fill="var(--surface)"
              height="34"
              rx="8"
              stroke="var(--line)"
              width={tooltipWidth}
              x={tooltipX}
              y={tooltipY}
            />
            <text fill="var(--muted)" fontSize="9" x={tooltipX + 9} y={tooltipY + 13}>
              {displayDate(selectedDay)} · {totals[selectedDay].clients} кл.
            </text>
            <text fill="var(--ink)" fontSize="11" fontWeight="700" x={tooltipX + 9} y={tooltipY + 27}>
              {money(totals[selectedDay].revenue)} сум
            </text>
          </g>
        ) : null}
      </svg>
    </div>
  );
}

function DebtsView({ data, reload, setError }) {
  const [showClosed, setShowClosed] = useState(false);
  const [openPaymentId, setOpenPaymentId] = useState(null);
  const [historyIds, setHistoryIds] = useState([]);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ counterparty: '', direction: 'i_owe', amount: '', currency: 'UZS', start_date: TODAY });
  const [payments, setPayments] = useState({});
  const myDebts = data.debts.filter((debt) => debt.direction === 'i_owe');
  const activeDebts = myDebts.filter((debt) => !debt.is_closed).sort(newestFirst);
  const closedDebts = myDebts.filter((debt) => debt.is_closed).sort(newestFirst);
  const currentMonth = TODAY.slice(0, 7);

  function shiftDebtMonth(offset) {
    const [year, month] = currentMonth.split('-').map(Number);
    const date = new Date(year, month - 1 + offset, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function debtMonthLabel(value) {
    const labels = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
    return labels[Number(value.slice(5, 7)) - 1];
  }

  function paid(debtId) {
    return data.debtPayments.filter((payment) => String(payment.debt_id) === String(debtId)).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  }

  function currencyPayments(currency, month) {
    const ids = new Set(myDebts.filter((debt) => debt.currency === currency).map((debt) => String(debt.id)));
    return data.debtPayments
      .filter((payment) => ids.has(String(payment.debt_id)) && String(payment.date).startsWith(month))
      .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  }

  const dashboard = ['USD', 'UZS'].map((currency) => {
    const currencyDebts = myDebts.filter((debt) => debt.currency === currency);
    const remaining = currencyDebts
      .filter((debt) => !debt.is_closed)
      .reduce((sum, debt) => sum + Math.max(0, Number(debt.amount) - paid(debt.id)), 0);
    const previousMonths = [-3, -2, -1].map(shiftDebtMonth);
    const average = previousMonths.reduce((sum, month) => sum + currencyPayments(currency, month), 0) / 3;
    const forecast = Math.max(0, remaining - average);
    const chartMonths = [-5, -4, -3, -2, -1, 0].map(shiftDebtMonth);
    const points = chartMonths.map((month) => {
      const started = currencyDebts
        .filter((debt) => !debt.start_date || String(debt.start_date).slice(0, 7) <= month)
        .reduce((sum, debt) => sum + (Number(debt.amount) || 0), 0);
      const debtIds = new Set(currencyDebts.map((debt) => String(debt.id)));
      const paidThroughMonth = data.debtPayments
        .filter((payment) => debtIds.has(String(payment.debt_id)) && String(payment.date).slice(0, 7) <= month)
        .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
      return { month, value: Math.max(0, started - paidThroughMonth) };
    });
    points.push({ month: shiftDebtMonth(1), value: forecast, forecast: true });
    return {
      currency,
      remaining,
      paidThisMonth: currencyPayments(currency, currentMonth),
      average,
      forecast,
      points,
    };
  });

  async function addDebt(event) {
    event.preventDefault();
    const amount = Number(form.amount);
    setError('');
    setMessage('');
    if (!form.counterparty.trim() || !amount) return setError('Укажите, кому вы должны, и сумму долга.');
    await callLegacyApi('addDebt', { ...form, amount, start_date: form.start_date || TODAY });
    setForm({ counterparty: '', direction: 'i_owe', amount: '', currency: 'UZS', start_date: TODAY });
    setMessage('Долг добавлен.');
    await reload();
  }

  async function addPayment(event, debt) {
    event.preventDefault();
    setError('');
    setMessage('');
    const payment = payments[debt.id] || {};
    const amount = Number(payment.amount);
    const remaining = Math.max(0, Number(debt.amount) - paid(debt.id));
    if (!amount) return setError('Введите сумму платежа.');
    if (amount > remaining) return setError(`Платёж больше остатка: ${money(remaining)} ${debt.currency}.`);
    await callLegacyApi('addDebtPayment', { debt_id: debt.id, date: payment.date || TODAY, amount });
    if (amount >= remaining && !debt.is_closed) {
      await callLegacyApi('setDebtClosed', { id: debt.id, is_closed: true });
    }
    setPayments((current) => ({ ...current, [debt.id]: { date: TODAY, amount: '' } }));
    setOpenPaymentId(null);
    setMessage('Платёж сохранён. Остаток пересчитан.');
    await reload();
  }

  async function deletePayment(payment, debt) {
    await callLegacyApi('delDebtPayment', { id });
    if (debt.is_closed) await callLegacyApi('setDebtClosed', { id: debt.id, is_closed: false });
    setMessage('Платёж удалён.');
    await reload();
  }

  async function reopenDebt(debt) {
    await callLegacyApi('setDebtClosed', { id: debt.id, is_closed: false });
    setMessage('Долг снова открыт.');
    await reload();
  }

  async function deleteDebt(id) {
    await callLegacyApi('delDebt', { id });
    await reload();
  }

  const renderDebt = (debt) => {
    const debtPayments = data.debtPayments
      .filter((payment) => String(payment.debt_id) === String(debt.id))
      .sort(newestFirst);
    const paidAmount = paid(debt.id);
    const remaining = Math.max(0, Number(debt.amount) - paidAmount);
    const progress = Math.min(100, Math.round((paidAmount / Math.max(Number(debt.amount), 1)) * 100));
    const paymentForm = payments[debt.id] || { date: TODAY, amount: '' };
    const previousMonths = [-3, -2, -1].map(shiftDebtMonth);
    const average = previousMonths.reduce((sum, month) => (
      sum + debtPayments
        .filter((payment) => String(payment.date).startsWith(month))
        .reduce((monthSum, payment) => monthSum + (Number(payment.amount) || 0), 0)
    ), 0) / 3;
    const payoffMonths = average > 0 ? Math.ceil(remaining / average) : null;
    const showHistory = historyIds.includes(debt.id);
    const showPayment = openPaymentId === debt.id;

    return (
      <article className={`debt-card debt-person-card ${debt.is_closed ? 'closed' : ''}`} key={debt.id}>
        <div className="debt-person-heading">
          <div>
            <span className="debt-status">{debt.is_closed ? 'Погашен' : 'Активный долг'}</span>
            <h4>{debt.counterparty}</h4>
            <small>С {displayDate(debt.start_date)}</small>
          </div>
          <div className="debt-person-balance">
            <span>Осталось</span>
            <strong>{debt.currency === 'USD' ? usdMoney(remaining) : `${money(remaining)} сум`}</strong>
          </div>
        </div>

        <div className="debt-progress-track"><span style={{ width: `${progress}%` }} /></div>
        <div className="debt-progress-meta">
          <span>Погашено {money(paidAmount)} из {money(debt.amount)} {debt.currency}</span>
          <strong>{progress}%</strong>
        </div>

        <div className="debt-person-stats">
          <div><span>Средний платёж</span><strong>{money(average)} {debt.currency} / мес.</strong></div>
          <div><span>Последний платёж</span><strong>{debtPayments[0] ? `${money(debtPayments[0].amount)} · ${displayDate(debtPayments[0].date)}` : 'Пока нет'}</strong></div>
          <div><span>До погашения</span><strong>{debt.is_closed ? 'Погашен' : payoffMonths ? `≈ ${payoffMonths} мес.` : 'Нужны платежи'}</strong></div>
        </div>

        {showPayment ? (
          <form className="debt-payment-form" onSubmit={(event) => addPayment(event, debt)}>
            <label>Дата<input type="date" value={paymentForm.date || TODAY} onChange={(event) => setPayments({ ...payments, [debt.id]: { ...paymentForm, date: event.target.value } })} /></label>
            <label>Сумма<MoneyInput placeholder="Сумма платежа" value={paymentForm.amount || ''} onChange={(amount) => setPayments({ ...payments, [debt.id]: { ...paymentForm, amount } })} /></label>
            <button className="btn" type="submit">Сохранить платёж</button>
          </form>
        ) : null}

        {showHistory ? (
          <div className="debt-payment-history">
            {debtPayments.length ? debtPayments.map((payment) => (
              <div className="debt-payment-row" key={payment.id}>
                <div><strong>{money(payment.amount)} {debt.currency}</strong><span>Погашение долга</span></div>
                <time>{displayDate(payment.date)}</time>
                <button className="debt-delete-payment" type="button" onClick={() => deletePayment(payment, debt)}>×</button>
              </div>
            )) : <p className="hint">Платежей пока нет.</p>}
          </div>
        ) : null}

        <div className="debt-card-actions">
          {!debt.is_closed ? <button className="btn" type="button" onClick={() => setOpenPaymentId(showPayment ? null : debt.id)}>{showPayment ? 'Отменить' : 'Внести платёж'}</button> : null}
          <button className="btn ghost" type="button" onClick={() => setHistoryIds((current) => showHistory ? current.filter((id) => id !== debt.id) : [...current, debt.id])}>{showHistory ? 'Скрыть историю' : `История (${debtPayments.length})`}</button>
          {debt.is_closed ? <button className="btn ghost" type="button" onClick={() => reopenDebt(debt)}>Открыть снова</button> : null}
          {debt.is_closed && !debtPayments.length ? <button className="btn danger-btn" type="button" onClick={() => deleteDebt(debt.id)}>Удалить</button> : null}
        </div>
      </article>
    );
  };

  return (
    <section className="view-grid debt-dashboard">
      <div className="card wide debt-page-heading">
        <div>
          <p className="debt-eyebrow">Мои обязательства</p>
          <h2>Долги</h2>
          <p>Остаток, история погашений и прогноз на следующий месяц.</p>
        </div>
      </div>

      {message ? <div className="notice success">{message}</div> : null}

      <div className="debt-summary-grid wide">
        {dashboard.map((item) => (
          <article className="debt-summary-card" key={item.currency}>
            <span>Осталось выплатить · {item.currency}</span>
            <strong>{item.currency === 'USD' ? usdMoney(item.remaining) : `${money(item.remaining)} сум`}</strong>
            <div>
              <p><span>Погашено в этом месяце</span><b>{money(item.paidThisMonth)} {item.currency}</b></p>
              <p><span>Остаток через месяц</span><b>{money(item.forecast)} {item.currency}</b></p>
            </div>
            <small>Прогноз по среднему платежу за 3 месяца: {money(item.average)} {item.currency}</small>
          </article>
        ))}
      </div>

      <div className="card wide">
        <div className="debt-section-heading">
          <div><h2>Как уменьшается долг</h2><p>Шесть месяцев истории и следующий месяц по прогнозу.</p></div>
        </div>
        <div className="debt-charts">
          {dashboard.map((item) => {
            const maxValue = Math.max(...item.points.map((point) => point.value), 1);
            return (
              <article className="debt-chart-card" key={item.currency}>
                <div className="debt-chart-heading">
                  <div><span>Остаток · {item.currency}</span><strong>{money(item.remaining)} {item.currency}</strong></div>
                  <small>последний — прогноз</small>
                </div>
                <div className="debt-mini-bars">
                  {item.points.map((point) => (
                    <div className={point.forecast ? 'forecast' : ''} key={point.month}>
                      <span title={`${money(point.value)} ${item.currency}`} style={{ height: `${Math.max(5, (point.value / maxValue) * 100)}%` }} />
                      <small>{debtMonthLabel(point.month)}</small>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div className="card wide">
        <div className="debt-section-heading">
          <div><h2>Кому я должен</h2><p>{activeDebts.length} активных · {closedDebts.length} погашенных</p></div>
          <button className={`btn ghost ${showClosed ? 'on' : ''}`} type="button" onClick={() => setShowClosed(!showClosed)}>{showClosed ? 'Скрыть погашенные' : 'Показать погашенные'}</button>
        </div>
        <div className="debt-card-list">
          <Rows rows={showClosed ? [...activeDebts, ...closedDebts] : activeDebts} empty="Активных долгов нет." render={renderDebt} />
        </div>
      </div>

      <form className="card wide debt-new-form" onSubmit={addDebt}>
        <div className="debt-section-heading"><div><h2>Добавить новый долг</h2><p>Выплаты будут автоматически уменьшать остаток.</p></div></div>
        <label>Кому я должен<input placeholder="Имя или организация" value={form.counterparty} onChange={(event) => setForm({ ...form, counterparty: event.target.value })} /></label>
        <label>Валюта<select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}><option value="UZS">UZS — сум</option><option value="USD">USD — доллар</option></select></label>
        <label>Сумма<MoneyInput placeholder="Сумма долга" value={form.amount} onChange={(amount) => setForm({ ...form, amount })} /></label>
        <label>Дата начала<input type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} /></label>
        <button className="btn" type="submit">Добавить долг</button>
      </form>
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

function SectionHeading({ label, range }) {
  return (
    <div className="section-heading">
      <h2>{label}</h2>
      <span className="date-badge">{displayRange(range)}</span>
    </div>
  );
}

function Tile({ label, value, secondary, hint, danger, tone }) {
  return (
    <div className={`tile ${danger ? 'danger' : ''} ${tone ? `tile-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {secondary ? <em>{secondary}</em> : null}
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
const VIEW_META = {
  master: {
    title: 'Рабочий день',
    description: 'Смена, продажи и заработок за выбранный период.',
  },
  admin: {
    title: 'Управление салоном',
    description: 'Подтверждения, выручка и работа команды.',
  },
  attendance: {
    title: 'Посещаемость',
    description: 'Приходы мастеров, опоздания и штрафы.',
  },
  finance: {
    title: 'Финансы салона',
    description: 'Прибыль, расходы и вложения за выбранный период.',
  },
};

function LoginGate({ error }) {
  return (
    <main className="login-gate">
      <div className="login-card">
        <img src="/icons/icon-192.png" alt="Maestro" />
        <h1>Maestro</h1>
        <p>Откройте приложение через Telegram, чтобы войти в учёт салона.</p>
        <a className="btn login-primary" href={TELEGRAM_BOT_LINK} rel="noreferrer" target="_blank">
          Открыть в Telegram
        </a>
        <button className="btn ghost" type="button" onClick={startTelegramOAuthLogin}>
          Войти на сайте через Telegram
        </button>
        {error ? <p className="error">{error}</p> : null}
      </div>
    </main>
  );
}

function ThemeControls({ theme, setTheme, dark, setDark }) {
  return (
    <div className="themebar">
      <div className="swatches" aria-label="Цветовая тема">
        {Object.entries(THEMES).map(([key, item]) => (
          <button
            aria-label={item.name}
            className={`swatch ${theme === key ? 'on' : ''}`}
            key={key}
            onClick={() => setTheme(key)}
            title={item.name}
            type="button"
          >
            <span style={{ background: item.light.brass }} />
          </button>
        ))}
      </div>

      <button
        aria-label={dark ? 'Включить светлую тему' : 'Включить тёмную тему'}
        className="dark-toggle"
        onClick={() => setDark((current) => !current)}
        title="Светлая / тёмная тема"
        type="button"
      >
        {dark ? '☀' : '☾'}
      </button>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(emptyState);
  const [view, setView] = useState('master');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [loginRequired, setLoginRequired] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('maestroTheme') || 'brass');
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('maestroDark');
    if (saved != null) return saved === 'true';
    return window.Telegram?.WebApp?.colorScheme === 'dark';
  });

  useEffect(() => {
    const selected = THEMES[theme] || THEMES.brass;
    const colors = selected[dark ? 'dark' : 'light'];
    Object.entries(colors).forEach(([key, value]) => document.documentElement.style.setProperty(`--${key}`, value));
    document.documentElement.style.setProperty(
      '--shadow',
      dark
        ? '0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)'
        : '0 1px 2px rgba(0,0,0,.05),0 8px 24px rgba(0,0,0,.05)',
    );
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('maestroTheme', theme);
    localStorage.setItem('maestroDark', String(dark));
  }, [dark, theme]);

  async function load({ preserveView = true } = {}) {
    setError('');
    if (preserveView) setIsRefreshing(true);
    else setIsLoading(true);

    try {
      await captureTelegramOAuthCode();
      captureTelegramRedirectAuth();

      if (needsTelegramLogin()) {
        setLoginRequired(true);
        return;
      }

      const result = await callLegacyApi('load');
      const normalized = normalizeData(result);
      setData(normalized);
      setLoginRequired(false);
      setView((currentView) => {
        const allowed = normalized.role === 'admin'
          ? ['master', 'admin', 'attendance', 'finance', 'debts']
          : ['master'];
        if (!preserveView) return normalized.role === 'admin' ? 'admin' : 'master';
        return allowed.includes(currentView) ? currentView : allowed[0];
      });
    } catch (loadError) {
      setError(loadError.message || 'Не удалось загрузить данные.');
      if (String(loadError.message).includes('unauthorized')) setLoginRequired(true);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    load({ preserveView: false });
  }, []);

  const availableViews = useMemo(() => {
    if (data.role === 'admin') return ['master', 'admin', 'attendance', 'finance', 'debts'];
    if (data.role === 'master') return ['master'];
    return [];
  }, [data.role]);

  if (loginRequired) return <LoginGate error={error} />;

  const CurrentView = {
    master: MasterView,
    admin: AdminView,
    attendance: AttendanceView,
    finance: FinanceView,
    debts: DebtsView,
  }[view] || MasterView;

  return (
    <main className="app">
      <div className="pole" />
      <header>
        <div className="topbar">
          <div className="brand">
            <div className="mark">M</div>
            <div>
              <h1>Maestro Barberia</h1>
              <p>{isLoading ? 'загрузка...' : data.role === 'master' && data.me ? `${data.me} · ${data.byName[data.me]?.pct || 40}%` : getTelegramFirstName() ? `привет, ${getTelegramFirstName()}` : 'учёт салона'}</p>
            </div>
          </div>
        </div>
        <ThemeControls theme={theme} setTheme={setTheme} dark={dark} setDark={setDark} />
      </header>

      {availableViews.length ? (
        <nav className="seg nav">
          {[
            ['master', 'Мастер'],
            ['admin', 'Админ'],
            ['attendance', 'Посещаемость'],
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
      {isRefreshing ? (
        <div className="loading-strip" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />Синхронизация данных...
        </div>
      ) : null}
      {!isLoading && VIEW_META[view] ? (
        <section className="view-intro" aria-labelledby="view-title">
          <p className="view-eyebrow">Maestro Barberia</p>
          <h2 id="view-title">{VIEW_META[view].title}</h2>
          <p>{VIEW_META[view].description}</p>
        </section>
      ) : null}
      {isLoading ? (
        <div className="loading-state" role="status" aria-live="polite">
          <div className="loading-emblem" aria-hidden="true">
            <span className="loading-emblem-ring loading-emblem-ring-outer" />
            <span className="loading-emblem-ring loading-emblem-ring-inner" />
            <span className="loading-emblem-core">M</span>
          </div>
          <strong>Загружаем данные салона</strong>
          <span>Проверяем Telegram-сессию и обновляем информацию.</span>
        </div>
      ) : <CurrentView data={data} reload={load} setError={setError} />}

      <footer>Данные сохраняются в облаке (Supabase). <span>{APP_VERSION}</span></footer>
    </main>
  );
}
