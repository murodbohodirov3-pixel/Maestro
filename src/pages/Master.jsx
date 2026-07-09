import { useEffect, useMemo, useState } from 'react';
import {
  createAttendanceForMaster,
  createSaleForMaster,
  deleteSale,
  getActiveMasters,
  getAttendanceForMaster,
  getFinesForMaster,
  getSalesForMaster,
  getSettings,
  getTodayAttendanceForMaster,
} from '../lib/api.js';
import {
  getCurrentMonthRange,
  getCurrentWeekRange,
  getTodayRange,
  isDateInRange,
  masterApprovedRevenue,
  masterClientsCount,
  masterFines,
  masterGrossPay,
  masterNetPayFromRevenue,
  masterNewClientsCount,
  masterOldClientsCount,
  saleClientsCount,
} from '../utils/calculations.js';

function money(value) {
  return Math.round(Number(value) || 0).toLocaleString('ru-RU');
}

function rowDate(row, primaryKey, legacyKey) {
  return row[primaryKey] || row[legacyKey] || '—';
}

function arrivalTime(row) {
  return row.arrived_at || row.arrived || '—';
}

function currentTimeHHMM() {
  return new Date().toTimeString().slice(0, 5);
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const radius = 6371000;
  const toRadians = (value) => (value * Math.PI) / 180;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLng / 2) ** 2;

  return 2 * radius * Math.asin(Math.sqrt(a));
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Геолокация недоступна на этом устройстве.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 8000,
    });
  });
}

function attendanceStatus(arrivedAt, shiftStart) {
  if (!arrivedAt) return '—';
  return arrivedAt <= (shiftStart || '09:00') ? 'Вовремя' : 'Опоздал';
}

function saleAmount(row) {
  return (Number(row.cash) || 0) + (Number(row.card) || 0) + (Number(row.qr) || 0);
}

function getMasterRange(period, customFrom, customTo) {
  if (period === 'today') return getTodayRange();
  if (period === 'week') return getCurrentWeekRange();
  if (period === 'current_month') return getCurrentMonthRange();
  if (period === 'custom') return { from: customFrom, to: customTo };
  return { from: '', to: '' };
}

function buildTotals(sales) {
  return sales.reduce(
    (totals, sale) => {
      totals.rows += 1;
      totals.cash += Number(sale.cash) || 0;
      totals.card += Number(sale.card) || 0;
      totals.qr += Number(sale.qr) || 0;
      totals.amount += saleAmount(sale);

      if (sale.status === 'pending') totals.pending += 1;
      if (sale.status === 'approved') totals.approved += 1;
      if (sale.status === 'rejected') totals.rejected += 1;

      return totals;
    },
    { rows: 0, cash: 0, card: 0, qr: 0, amount: 0, pending: 0, approved: 0, rejected: 0 },
  );
}

export default function Master({ currentUser }) {
  const [masters, setMasters] = useState([]);
  const [selectedMasterId, setSelectedMasterId] = useState('');
  const [sales, setSales] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [fines, setFines] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMasters, setIsLoadingMasters] = useState(false);
  const [isSavingSale, setIsSavingSale] = useState(false);
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [error, setError] = useState('');
  const [saleMessage, setSaleMessage] = useState('');
  const [checkinMessage, setCheckinMessage] = useState('');
  const [todayAttendance, setTodayAttendance] = useState(null);
  const [shiftStart, setShiftStart] = useState('09:00');
  const [period, setPeriod] = useState('current_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [saleForm, setSaleForm] = useState({
    cash: '',
    card: '',
    qr: '',
    clientsCount: '1',
    isNewClient: false,
  });

  const hasAccess = ['owner', 'admin', 'master'].includes(currentUser.role);
  const canPickMaster = ['owner', 'admin'].includes(currentUser.role);
  const activeMasterId = currentUser.role === 'master' ? currentUser.master_id : selectedMasterId;
  const canLoadMasterData = Boolean(activeMasterId);
  const canCreateSale = currentUser.role === 'master' && canLoadMasterData;
  const canCheckin = currentUser.role === 'master' && canLoadMasterData;
  const selectedMaster = masters.find((master) => String(master.id) === String(activeMasterId));
  const reportMaster = selectedMaster;
  const range = useMemo(
    () => getMasterRange(period, customFrom, customTo),
    [customFrom, customTo, period],
  );
  const filteredSales = useMemo(
    () => sales.filter((sale) => isDateInRange(sale.sale_date || sale.d, range.from, range.to)),
    [range.from, range.to, sales],
  );
  const filteredAttendance = useMemo(
    () =>
      attendance.filter((item) =>
        isDateInRange(item.attendance_date || item.d, range.from, range.to),
      ),
    [attendance, range.from, range.to],
  );
  const filteredFines = useMemo(
    () => fines.filter((fine) => isDateInRange(fine.fine_date || fine.d, range.from, range.to)),
    [fines, range.from, range.to],
  );
  const totals = useMemo(() => buildTotals(filteredSales), [filteredSales]);
  const todaySales = useMemo(
    () => sales.filter((sale) => isDateInRange(sale.sale_date || sale.d, getTodayRange().from, getTodayRange().to)),
    [sales],
  );
  const earningReport = useMemo(() => {
    const approvedRevenue = masterApprovedRevenue(filteredSales, activeMasterId);
    const finesAmount = masterFines(filteredFines, activeMasterId);
    const pct = Number(reportMaster?.pct ?? 0);
    const grossPay = masterGrossPay(approvedRevenue, pct);

    return {
      approvedRevenue,
      pct,
      grossPay,
      finesAmount,
      netPay: masterNetPayFromRevenue(approvedRevenue, pct, finesAmount),
      clients: masterClientsCount(filteredSales, activeMasterId),
      newClients: masterNewClientsCount(filteredSales, activeMasterId),
      oldClients: masterOldClientsCount(filteredSales, activeMasterId),
    };
  }, [activeMasterId, filteredFines, filteredSales, reportMaster?.pct]);

  async function refreshSales() {
    const salesRows = await getSalesForMaster(activeMasterId);
    setSales(salesRows);
  }

  async function refreshAttendance() {
    const attendanceRows = await getAttendanceForMaster(activeMasterId);
    setAttendance(attendanceRows);
  }

  useEffect(() => {
    if (!canPickMaster && currentUser.role !== 'master') return;

    async function loadMasters() {
      setIsLoadingMasters(true);
      setError('');

      try {
        const rows = await getActiveMasters();
        setMasters(rows);
      } catch (loadError) {
        setError(loadError.message || 'Не удалось загрузить список мастеров.');
      } finally {
        setIsLoadingMasters(false);
      }
    }

    loadMasters();
  }, [canPickMaster, currentUser.role]);

  useEffect(() => {
    if (!canLoadMasterData) {
      setSales([]);
      setAttendance([]);
      setFines([]);
      setTodayAttendance(null);
      setCheckinMessage('');
      return;
    }

    let isMounted = true;

    async function loadMasterData() {
      setIsLoading(true);
      setError('');

      try {
        const [salesRows, attendanceRows, fineRows, todayAttendanceRow, settingsRow] = await Promise.all([
          getSalesForMaster(activeMasterId),
          getAttendanceForMaster(activeMasterId),
          getFinesForMaster(activeMasterId),
          getTodayAttendanceForMaster(activeMasterId),
          getSettings(),
        ]);

        if (!isMounted) return;

        setSales(salesRows);
        setAttendance(attendanceRows);
        setFines(fineRows);
        setTodayAttendance(todayAttendanceRow);
        setShiftStart(settingsRow?.shift_start || '09:00');
      } catch (loadError) {
        if (!isMounted) return;
        setError(loadError.message || 'Не удалось загрузить данные мастера.');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadMasterData();

    return () => {
      isMounted = false;
    };
  }, [activeMasterId, canLoadMasterData]);

  function updateSaleForm(field, value) {
    setSaleForm((current) => ({ ...current, [field]: value }));
  }

  async function handleCreateSale(event) {
    event.preventDefault();
    setError('');
    setSaleMessage('');

    const total =
      (Number(saleForm.cash) || 0) + (Number(saleForm.card) || 0) + (Number(saleForm.qr) || 0);

    if (total <= 0) {
      setError('Сумма продажи должна быть больше 0.');
      return;
    }

    setIsSavingSale(true);

    try {
      await createSaleForMaster({
        currentUser,
        masterName: currentUser.name || '',
        cash: saleForm.cash,
        card: saleForm.card,
        qr: saleForm.qr,
        clientsCount: saleForm.clientsCount,
        isNewClient: saleForm.isNewClient,
      });

      setSaleForm({
        cash: '',
        card: '',
        qr: '',
        clientsCount: '1',
        isNewClient: false,
      });
      setSaleMessage('Продажа добавлена и ожидает подтверждения');
      await refreshSales();
    } catch (saveError) {
      setError(saveError.message || 'Не удалось добавить продажу.');
    } finally {
      setIsSavingSale(false);
    }
  }

  async function handleDeleteSale(sale) {
    if (sale.status !== 'pending') {
      setError('Можно удалить только pending-продажу.');
      return;
    }

    if (currentUser.role === 'master' && String(sale.master_id) !== String(currentUser.master_id)) {
      setError('Мастер может удалить только свою pending-продажу.');
      return;
    }

    if (!confirm('Удалить pending-продажу?')) return;

    setError('');
    setSaleMessage('');

    try {
      await deleteSale(sale.id);
      setSaleMessage('Pending-продажа удалена.');
      await refreshSales();
    } catch (deleteError) {
      setError(deleteError.message || 'Не удалось удалить продажу.');
    }
  }

  async function handleCheckin() {
    setError('');
    setCheckinMessage('');

    if (todayAttendance) {
      setCheckinMessage('Вы уже отметились сегодня.');
      return;
    }

    setIsCheckingIn(true);

    try {
      const latestTodayAttendance = await getTodayAttendanceForMaster(activeMasterId);
      if (latestTodayAttendance) {
        setTodayAttendance(latestTodayAttendance);
        setCheckinMessage('Вы уже отметились сегодня.');
        return;
      }

      const settings = await getSettings();
      const salonLat = Number(settings?.salon_lat);
      const salonLng = Number(settings?.salon_lng);
      const salonRadius = Number(settings?.salon_radius);

      if (
        !settings ||
        !Number.isFinite(salonLat) ||
        !Number.isFinite(salonLng) ||
        !Number.isFinite(salonRadius) ||
        salonRadius <= 0
      ) {
        setError('Настройки салона не заполнены.');
        return;
      }

      const position = await getCurrentPosition();
      const distance = distanceMeters(
        position.coords.latitude,
        position.coords.longitude,
        salonLat,
        salonLng,
      );

      if (distance > salonRadius) {
        setError('Вы далеко от салона.');
        return;
      }

      const arrivedTime = currentTimeHHMM();
      const row = await createAttendanceForMaster({
        currentUser,
        masterName: reportMaster?.name || currentUser.name || '',
        arrivedTime,
      });

      setTodayAttendance(row);
      setCheckinMessage('Вы отметились сегодня.');
      await refreshAttendance();
    } catch (checkinError) {
      const isGeolocationError =
        checkinError?.code === 1 || checkinError?.code === 2 || checkinError?.code === 3;
      setError(
        isGeolocationError
          ? 'Геолокация недоступна или запрещена.'
          : checkinError.message || 'Геолокация недоступна или запрещена.',
      );
    } finally {
      setIsCheckingIn(false);
    }
  }

  if (!hasAccess) {
    return (
      <div className="placeholder-page">
        <h2>Мастер</h2>
        <p>Нет доступа</p>
      </div>
    );
  }

  return (
    <div className="master-page">
      <h2>Мастер</h2>
      <p>Имя пользователя: {currentUser.name || 'Без имени'}</p>
      <p>Роль: {currentUser.role}</p>
      {currentUser.master_id ? <p>master_id: {currentUser.master_id}</p> : null}

      {canPickMaster ? (
        <section className="filter-panel">
          <label className="master-select-label">
            Выберите мастера
            <select
              disabled={isLoadingMasters}
              onChange={(event) => setSelectedMasterId(event.target.value)}
              value={selectedMasterId}
            >
              <option value="">Выберите мастера</option>
              {masters.map((master) => (
                <option key={master.id} value={master.id}>
                  {master.name} · {master.pct}%
                </option>
              ))}
            </select>
          </label>
        </section>
      ) : null}

      {canLoadMasterData ? (
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
            <button className={period === 'week' ? 'active' : ''} onClick={() => setPeriod('week')} type="button">
              Неделя
            </button>
            <button className={period === 'all' ? 'active' : ''} onClick={() => setPeriod('all')} type="button">
              Все время
            </button>
            <button className={period === 'custom' ? 'active' : ''} onClick={() => setPeriod('custom')} type="button">
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
      ) : null}

      {!canLoadMasterData ? <p className="empty-state">Выберите мастера позже</p> : null}
      {isLoading ? <p className="empty-state">Загрузка данных...</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {canLoadMasterData && !isLoading ? (
        <>
          {selectedMaster ? <p className="empty-state">Выбран мастер: {selectedMaster.name}</p> : null}

          <section className="data-section">
            <h3>Посещаемость сегодня</h3>
            {todayAttendance ? (
              <div className="simple-list">
                <div className="list-row">
                  <span>Время прихода</span>
                  <strong>{arrivalTime(todayAttendance)}</strong>
                </div>
                <div className="list-row">
                  <span>Статус</span>
                  <strong>{attendanceStatus(arrivalTime(todayAttendance), shiftStart)}</strong>
                </div>
              </div>
            ) : (
              <>
                <p className="empty-state">Сегодня отметки прихода пока нет.</p>
                {canCheckin ? (
                  <button
                    className="primary-action"
                    disabled={isCheckingIn}
                    onClick={handleCheckin}
                    type="button"
                  >
                    {isCheckingIn ? 'Проверяем геолокацию...' : 'Я пришёл'}
                  </button>
                ) : null}
              </>
            )}
            {checkinMessage ? <p className="success-text">{checkinMessage}</p> : null}
          </section>

          {canCreateSale ? (
            <section className="data-section">
              <h3>Добавить продажу</h3>
              <form className="sale-form" onSubmit={handleCreateSale}>
                <label>
                  Наличные
                  <input
                    inputMode="numeric"
                    min="0"
                    onChange={(event) => updateSaleForm('cash', event.target.value)}
                    placeholder="0"
                    type="number"
                    value={saleForm.cash}
                  />
                </label>
                <label>
                  Карта
                  <input
                    inputMode="numeric"
                    min="0"
                    onChange={(event) => updateSaleForm('card', event.target.value)}
                    placeholder="0"
                    type="number"
                    value={saleForm.card}
                  />
                </label>
                <label>
                  QR
                  <input
                    inputMode="numeric"
                    min="0"
                    onChange={(event) => updateSaleForm('qr', event.target.value)}
                    placeholder="0"
                    type="number"
                    value={saleForm.qr}
                  />
                </label>
                <label>
                  Количество клиентов
                  <input
                    inputMode="numeric"
                    min="1"
                    onChange={(event) => updateSaleForm('clientsCount', event.target.value)}
                    type="number"
                    value={saleForm.clientsCount}
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    checked={saleForm.isNewClient}
                    onChange={(event) => updateSaleForm('isNewClient', event.target.checked)}
                    type="checkbox"
                  />
                  Новый клиент
                </label>
                <button disabled={isSavingSale} type="submit">
                  {isSavingSale ? 'Добавляем...' : 'Добавить продажу'}
                </button>
              </form>
              {saleMessage ? <p className="success-text">{saleMessage}</p> : null}
            </section>
          ) : null}

          <section className="data-section">
            <h3>Сегодня</h3>
            {todaySales.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Время</th>
                      <th>Наличные</th>
                      <th>Карта</th>
                      <th>QR</th>
                      <th>Сумма</th>
                      <th>Клиенты</th>
                      <th>Новый</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {todaySales.map((sale) => (
                      <tr key={sale.id}>
                        <td>{sale.created_at ? new Date(sale.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        <td>{money(sale.cash)}</td>
                        <td>{money(sale.card)}</td>
                        <td>{money(sale.qr)}</td>
                        <td>{money(saleAmount(sale))}</td>
                        <td>{saleClientsCount(sale)}</td>
                        <td>{sale.is_new_client ? 'да' : 'нет'}</td>
                        <td>{sale.status || '—'}</td>
                        <td>
                          {sale.status === 'pending' ? (
                            <button className="table-action danger" onClick={() => handleDeleteSale(sale)} type="button">
                              Удалить
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-state">Сегодня продаж пока нет.</p>
            )}
          </section>

          <section className="data-section">
            <h3>Мой заработок</h3>
            <div className="totals-grid">
              <div>
                <span>Approved revenue</span>
                <strong>{money(earningReport.approvedRevenue)}</strong>
              </div>
              <div>
                <span>Процент</span>
                <strong>{earningReport.pct}%</strong>
              </div>
              <div>
                <span>Начислено до штрафов</span>
                <strong>{money(earningReport.grossPay)}</strong>
              </div>
              <div>
                <span>Штрафы</span>
                <strong>{money(earningReport.finesAmount)}</strong>
              </div>
              <div>
                <span>К выплате</span>
                <strong>{money(earningReport.netPay)}</strong>
              </div>
              <div>
                <span>Клиентов всего</span>
                <strong>{earningReport.clients}</strong>
              </div>
              <div>
                <span>Новых клиентов</span>
                <strong>{earningReport.newClients}</strong>
              </div>
              <div>
                <span>Постоянных клиентов</span>
                <strong>{earningReport.oldClients}</strong>
              </div>
            </div>
          </section>

          <section className="data-section">
            <h3>Итоги продаж</h3>
            <div className="totals-grid">
              <div>
                <span>Строк</span>
                <strong>{totals.rows}</strong>
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
                <span>Total amount</span>
                <strong>{money(totals.amount)}</strong>
              </div>
              <div>
                <span>Pending</span>
                <strong>{totals.pending}</strong>
              </div>
              <div>
                <span>Approved</span>
                <strong>{totals.approved}</strong>
              </div>
              <div>
                <span>Rejected</span>
                <strong>{totals.rejected}</strong>
              </div>
            </div>
          </section>

          <section className="data-section">
            <h3>Продажи мастера</h3>
            {filteredSales.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Наличные</th>
                      <th>Карта</th>
                      <th>QR</th>
                      <th>Сумма</th>
                      <th>Клиенты</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSales.map((sale) => (
                      <tr key={sale.id}>
                        <td>{rowDate(sale, 'sale_date', 'd')}</td>
                        <td>{money(sale.cash)}</td>
                        <td>{money(sale.card)}</td>
                        <td>{money(sale.qr)}</td>
                        <td>{money(saleAmount(sale))}</td>
                        <td>{saleClientsCount(sale)}</td>
                        <td>{sale.status || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-state">Продаж за выбранный период пока нет.</p>
            )}
          </section>

          <section className="data-section">
            <h3>Посещаемость</h3>
            {filteredAttendance.length ? (
              <div className="simple-list">
                {filteredAttendance.map((item) => (
                  <div className="list-row" key={item.id}>
                    <span>{rowDate(item, 'attendance_date', 'd')}</span>
                    <strong>{arrivalTime(item)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-state">Посещаемости за выбранный период пока нет.</p>
            )}
          </section>

          <section className="data-section">
            <h3>Штрафы</h3>
            {filteredFines.length ? (
              <div className="simple-list">
                {filteredFines.map((fine) => (
                  <div className="list-row" key={fine.id}>
                    <span>{rowDate(fine, 'fine_date', 'd')}</span>
                    <strong>{money(fine.amount)}</strong>
                    <span>{fine.reason || '—'}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-state">Штрафов за выбранный период пока нет.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
