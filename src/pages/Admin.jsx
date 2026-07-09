import { useEffect, useMemo, useState } from 'react';
import {
  createAttendance,
  createFine,
  deleteAttendance,
  deleteFine,
  getActiveMasters,
  getAdminSales,
  getAllAttendance,
  getAllFines,
  getSettings,
  updateAttendance,
  updateSaleStatus,
  updateSettings,
} from '../lib/api.js';
import {
  getCurrentMonthRange,
  getTodayRange,
  isDateInRange,
  saleClientsCount,
} from '../utils/calculations.js';

function money(value) {
  return Math.round(Number(value) || 0).toLocaleString('ru-RU');
}

function todayLocalDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function saleAmount(row) {
  return (Number(row.cash) || 0) + (Number(row.card) || 0) + (Number(row.qr) || 0);
}

function rowDate(row) {
  return row.sale_date || row.d || '—';
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

function getAdminRange(period, customFrom, customTo) {
  if (period === 'today') return getTodayRange();
  if (period === 'current_month') return getCurrentMonthRange();
  if (period === 'custom') return { from: customFrom, to: customTo };
  return { from: '', to: '' };
}

function displayTime(value) {
  if (!value) return '';
  if (String(value).includes('T')) {
    const date = new Date(value);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 5);
}

function minutesLate(arrivedAt, shiftStart) {
  const arrived = displayTime(arrivedAt);
  if (!arrived) return null;

  const [h, m] = arrived.split(':').map(Number);
  const [shiftH, shiftM] = (shiftStart || '09:00').split(':').map(Number);
  return h * 60 + m - (shiftH * 60 + shiftM);
}

function attendanceStatus(arrivedAt, shiftStart) {
  const late = minutesLate(arrivedAt, shiftStart);
  if (late == null) return 'нет времени';
  return late > 0 ? `опоздал на ${late} мин` : 'вовремя';
}

function emptyAttendanceForm() {
  return { master_id: '', date: todayLocalDate(), arrived_at: '' };
}

function emptyFineForm() {
  return { master_id: '', date: todayLocalDate(), amount: '', reason: '' };
}

export default function Admin({ currentUser }) {
  const [sales, setSales] = useState([]);
  const [masters, setMasters] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [fines, setFines] = useState([]);
  const [settings, setSettings] = useState(null);
  const [attendanceTimes, setAttendanceTimes] = useState({});
  const [attendanceForm, setAttendanceForm] = useState(emptyAttendanceForm);
  const [fineForm, setFineForm] = useState(emptyFineForm);
  const [settingsForm, setSettingsForm] = useState({
    shift_start: '09:00',
    salon_lat: '',
    salon_lng: '',
    salon_radius: '100',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [updatingSaleId, setUpdatingSaleId] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');
  const [period, setPeriod] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const hasAccess = ['owner', 'admin'].includes(currentUser.role);
  const range = useMemo(
    () => getAdminRange(period, customFrom, customTo),
    [customFrom, customTo, period],
  );
  const shiftStart = settingsForm.shift_start || settings?.shift_start || '09:00';

  const visibleSales = useMemo(
    () =>
      sales.filter((sale) => {
        const statusMatches = statusFilter === 'all' || sale.status === statusFilter;
        const dateMatches = isDateInRange(sale.sale_date || sale.d, range.from, range.to);
        return statusMatches && dateMatches;
      }),
    [range.from, range.to, sales, statusFilter],
  );

  const visibleAttendance = useMemo(
    () =>
      attendance.filter((item) =>
        isDateInRange(item.attendance_date || item.d, range.from, range.to),
      ),
    [attendance, range.from, range.to],
  );

  const visibleFines = useMemo(
    () => fines.filter((fine) => isDateInRange(fine.fine_date || fine.d, range.from, range.to)),
    [fines, range.from, range.to],
  );

  function getMaster(masterId) {
    return masters.find((master) => String(master.id) === String(masterId));
  }

  async function loadAdminData() {
    setIsLoading(true);
    setError('');

    try {
      const [salesRows, masterRows, attendanceRows, fineRows, settingsRow] = await Promise.all([
        getAdminSales(),
        getActiveMasters(),
        getAllAttendance(),
        getAllFines(),
        getSettings(),
      ]);

      setSales(salesRows);
      setMasters(masterRows);
      setAttendance(attendanceRows);
      setFines(fineRows);
      setSettings(settingsRow);
      setAttendanceTimes(
        attendanceRows.reduce((map, item) => ({ ...map, [item.id]: displayTime(item.arrived_at || item.arrived) }), {}),
      );
      if (settingsRow) {
        setSettingsForm({
          shift_start: settingsRow.shift_start || '09:00',
          salon_lat: settingsRow.salon_lat ?? '',
          salon_lng: settingsRow.salon_lng ?? '',
          salon_radius: settingsRow.salon_radius || '100',
        });
      }
    } catch (loadError) {
      setError(loadError.message || 'Не удалось загрузить данные админа.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (hasAccess) {
      loadAdminData();
    }
  }, [hasAccess]);

  async function handleStatusChange(saleId, status) {
    setUpdatingSaleId(saleId);
    setError('');
    setMessage('');

    try {
      await updateSaleStatus({ saleId, status, currentUser });
      await loadAdminData();
      setMessage(status === 'approved' ? 'Продажа подтверждена.' : 'Продажа отклонена.');
    } catch (updateError) {
      setError(updateError.message || 'Не удалось обновить статус продажи.');
    } finally {
      setUpdatingSaleId(null);
    }
  }

  async function handleCreateAttendance(event) {
    event.preventDefault();
    setError('');
    setMessage('');

    const master = getMaster(attendanceForm.master_id);
    if (!master) {
      setError('Выберите мастера.');
      return;
    }
    if (!attendanceForm.arrived_at) {
      setError('Укажите время прихода.');
      return;
    }

    try {
      await createAttendance({
        master_id: master.id,
        master: master.name,
        attendance_date: attendanceForm.date,
        d: attendanceForm.date,
        arrived_at: attendanceForm.arrived_at,
        arrived: attendanceForm.arrived_at,
      });
      setAttendanceForm(emptyAttendanceForm());
      setMessage('Отметка посещаемости добавлена.');
      await loadAdminData();
    } catch (createError) {
      setError(createError.message || 'Не удалось добавить отметку.');
    }
  }

  async function handleUpdateAttendance(item) {
    setError('');
    setMessage('');

    const time = attendanceTimes[item.id];
    if (!time) {
      setError('Укажите время прихода.');
      return;
    }

    try {
      await updateAttendance(item.id, {
        arrived_at: time,
        arrived: time,
      });
      setMessage('Время прихода обновлено.');
      await loadAdminData();
    } catch (updateError) {
      setError(updateError.message || 'Не удалось обновить посещаемость.');
    }
  }

  async function handleDeleteAttendance(item) {
    if (!confirm(`Удалить отметку ${item.master || 'мастера'} за ${item.attendance_date || item.d || ''}?`)) return;

    setError('');
    setMessage('');

    try {
      await deleteAttendance(item.id);
      setMessage('Отметка удалена.');
      await loadAdminData();
    } catch (deleteError) {
      setError(deleteError.message || 'Не удалось удалить отметку.');
    }
  }

  function handleQuickFine(item) {
    setFineForm({
      master_id: String(item.master_id || ''),
      date: item.attendance_date || item.d || todayLocalDate(),
      amount: '',
      reason: 'Опоздание',
    });
    setMessage('Заполните сумму штрафа и нажмите “Добавить штраф”.');
  }

  async function handleCreateFine(event) {
    event.preventDefault();
    setError('');
    setMessage('');

    const master = getMaster(fineForm.master_id);
    if (!master) {
      setError('Выберите мастера для штрафа.');
      return;
    }
    if ((Number(fineForm.amount) || 0) <= 0) {
      setError('Сумма штрафа должна быть больше 0.');
      return;
    }

    try {
      await createFine({
        master_id: master.id,
        master: master.name,
        fine_date: fineForm.date,
        d: fineForm.date,
        amount: fineForm.amount,
        reason: fineForm.reason,
        created_by: currentUser.name || null,
      });
      setFineForm(emptyFineForm());
      setMessage('Штраф добавлен.');
      await loadAdminData();
    } catch (createError) {
      setError(createError.message || 'Не удалось добавить штраф.');
    }
  }

  async function handleDeleteFine(fine) {
    if (!confirm(`Удалить штраф ${fine.master || 'мастера'} на ${money(fine.amount)}?`)) return;

    setError('');
    setMessage('');

    try {
      await deleteFine(fine.id);
      setMessage('Штраф удален.');
      await loadAdminData();
    } catch (deleteError) {
      setError(deleteError.message || 'Не удалось удалить штраф.');
    }
  }

  async function handleSaveSettings(event) {
    event.preventDefault();
    setError('');
    setMessage('');

    try {
      await updateSettings({
        shift_start: settingsForm.shift_start || '09:00',
        salon_lat: settingsForm.salon_lat === '' ? null : Number(settingsForm.salon_lat),
        salon_lng: settingsForm.salon_lng === '' ? null : Number(settingsForm.salon_lng),
        salon_radius: Number(settingsForm.salon_radius) || 100,
      });
      setMessage('Настройки сохранены.');
      await loadAdminData();
    } catch (settingsError) {
      setError(settingsError.message || 'Не удалось сохранить настройки.');
    }
  }

  if (!hasAccess) {
    return (
      <div className="placeholder-page">
        <h2>Админ</h2>
        <p>Нет доступа</p>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <h2>Админ</h2>
      <p>Имя пользователя: {currentUser.name || 'Без имени'}</p>
      <p>Роль: {currentUser.role}</p>
      {currentUser.master_id ? <p>master_id: {currentUser.master_id}</p> : null}

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
        <div className="filter-buttons">
          {['pending', 'approved', 'rejected', 'all'].map((status) => (
            <button
              className={statusFilter === status ? 'active' : ''}
              key={status}
              onClick={() => setStatusFilter(status)}
              type="button"
            >
              {status}
            </button>
          ))}
        </div>
      </section>

      {isLoading ? <p className="empty-state">Загрузка данных...</p> : null}
      {message ? <p className="success-text">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      <section className="data-section">
        <h3>Посещаемость</h3>
        <form className="admin-form" onSubmit={handleCreateAttendance}>
          <label>
            Мастер
            <select
              onChange={(event) => setAttendanceForm((current) => ({ ...current, master_id: event.target.value }))}
              value={attendanceForm.master_id}
            >
              <option value="">Выберите мастера</option>
              {masters.map((master) => (
                <option key={master.id} value={master.id}>
                  {master.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Дата
            <input
              onChange={(event) => setAttendanceForm((current) => ({ ...current, date: event.target.value }))}
              type="date"
              value={attendanceForm.date}
            />
          </label>
          <label>
            Время прихода
            <input
              onChange={(event) => setAttendanceForm((current) => ({ ...current, arrived_at: event.target.value }))}
              type="time"
              value={attendanceForm.arrived_at}
            />
          </label>
          <button type="submit">Добавить отметку</button>
        </form>

        {visibleAttendance.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Мастер</th>
                  <th>Дата</th>
                  <th>Время прихода</th>
                  <th>Статус</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {visibleAttendance.map((item) => (
                  <tr key={item.id}>
                    <td>{item.master || '—'}</td>
                    <td>{item.attendance_date || item.d || '—'}</td>
                    <td>
                      <input
                        className="inline-time"
                        onChange={(event) =>
                          setAttendanceTimes((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                        type="time"
                        value={attendanceTimes[item.id] || ''}
                      />
                    </td>
                    <td>{attendanceStatus(attendanceTimes[item.id] || item.arrived_at || item.arrived, shiftStart)}</td>
                    <td>
                      <div className="table-actions">
                        <button className="table-action" onClick={() => handleUpdateAttendance(item)} type="button">
                          Изменить
                        </button>
                        <button className="table-action danger" onClick={() => handleDeleteAttendance(item)} type="button">
                          Удалить
                        </button>
                        <button className="table-action warning" onClick={() => handleQuickFine(item)} type="button">
                          Штраф
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">Посещаемости за выбранный период нет.</p>
        )}
      </section>

      <section className="data-section">
        <h3>Штрафы</h3>
        <form className="admin-form" onSubmit={handleCreateFine}>
          <label>
            Мастер
            <select
              onChange={(event) => setFineForm((current) => ({ ...current, master_id: event.target.value }))}
              value={fineForm.master_id}
            >
              <option value="">Выберите мастера</option>
              {masters.map((master) => (
                <option key={master.id} value={master.id}>
                  {master.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Дата
            <input
              onChange={(event) => setFineForm((current) => ({ ...current, date: event.target.value }))}
              type="date"
              value={fineForm.date}
            />
          </label>
          <label>
            Сумма
            <input
              inputMode="numeric"
              onChange={(event) => setFineForm((current) => ({ ...current, amount: event.target.value }))}
              type="number"
              value={fineForm.amount}
            />
          </label>
          <label>
            Причина
            <input
              onChange={(event) => setFineForm((current) => ({ ...current, reason: event.target.value }))}
              value={fineForm.reason}
            />
          </label>
          <button type="submit">Добавить штраф</button>
        </form>

        {visibleFines.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Мастер</th>
                  <th>Дата</th>
                  <th>Сумма</th>
                  <th>Причина</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visibleFines.map((fine) => (
                  <tr key={fine.id}>
                    <td>{fine.master || '—'}</td>
                    <td>{fine.fine_date || fine.d || '—'}</td>
                    <td>{money(fine.amount)}</td>
                    <td>{fine.reason || '—'}</td>
                    <td>
                      <button className="table-action danger" onClick={() => handleDeleteFine(fine)} type="button">
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">Штрафов за выбранный период нет.</p>
        )}
      </section>

      <section className="data-section">
        <h3>Настройки смены и салона</h3>
        <form className="admin-form" onSubmit={handleSaveSettings}>
          <label>
            Начало смены
            <input
              onChange={(event) => setSettingsForm((current) => ({ ...current, shift_start: event.target.value }))}
              type="time"
              value={settingsForm.shift_start}
            />
          </label>
          <label>
            Широта
            <input
              onChange={(event) => setSettingsForm((current) => ({ ...current, salon_lat: event.target.value }))}
              step="any"
              type="number"
              value={settingsForm.salon_lat}
            />
          </label>
          <label>
            Долгота
            <input
              onChange={(event) => setSettingsForm((current) => ({ ...current, salon_lng: event.target.value }))}
              step="any"
              type="number"
              value={settingsForm.salon_lng}
            />
          </label>
          <label>
            Радиус, м
            <input
              onChange={(event) => setSettingsForm((current) => ({ ...current, salon_radius: event.target.value }))}
              type="number"
              value={settingsForm.salon_radius}
            />
          </label>
          <button type="submit">Сохранить настройки</button>
        </form>
      </section>

      <section className="data-section">
        <h3>Продажи</h3>
        {!visibleSales.length ? (
          <p className="empty-state">Продаж по выбранным фильтрам пока нет.</p>
        ) : null}

        {visibleSales.length ? (
          <div className="pending-sales-list">
            {visibleSales.map((sale) => (
              <article className="pending-sale-card" key={sale.id}>
                <div className="pending-sale-main">
                  <div>
                    <span>Дата</span>
                    <strong>{rowDate(sale)}</strong>
                  </div>
                  <div>
                    <span>Мастер</span>
                    <strong>{sale.master || '—'}</strong>
                  </div>
                  <div>
                    <span>Наличные</span>
                    <strong>{money(sale.cash)}</strong>
                  </div>
                  <div>
                    <span>Карта</span>
                    <strong>{money(sale.card)}</strong>
                  </div>
                  <div>
                    <span>QR</span>
                    <strong>{money(sale.qr)}</strong>
                  </div>
                  <div>
                    <span>Сумма</span>
                    <strong>{money(saleAmount(sale))}</strong>
                  </div>
                  <div>
                    <span>Клиенты</span>
                    <strong>{saleClientsCount(sale)}</strong>
                  </div>
                  <div>
                    <span>Новый клиент</span>
                    <strong>{sale.is_new_client ? 'да' : 'нет'}</strong>
                  </div>
                  <div>
                    <span>Создано</span>
                    <strong>{formatDateTime(sale.created_at)}</strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong>{sale.status || '—'}</strong>
                  </div>
                </div>

                {sale.status === 'pending' ? (
                  <div className="pending-sale-actions">
                    <button
                      disabled={updatingSaleId === sale.id}
                      onClick={() => handleStatusChange(sale.id, 'approved')}
                      type="button"
                    >
                      Подтвердить
                    </button>
                    <button
                      className="danger"
                      disabled={updatingSaleId === sale.id}
                      onClick={() => handleStatusChange(sale.id, 'rejected')}
                      type="button"
                    >
                      Отклонить
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
