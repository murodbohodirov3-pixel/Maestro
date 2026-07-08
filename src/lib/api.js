import { supabase } from './supabase.js';

function getSupabaseClient() {
  if (!supabase) {
    throw new Error('Supabase не настроен. Проверьте VITE_SUPABASE_URL и VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  return supabase;
}

function todayLocalDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function toMoneyNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function getAppUserByTelegramId(telegramId) {
  if (!telegramId) return null;

  const { data, error } = await getSupabaseClient()
    .from('app_users')
    .select('id,name,telegram_id,role,master_id,active')
    .eq('telegram_id', String(telegramId))
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function getActiveMasters() {
  const { data, error } = await getSupabaseClient()
    .from('masters')
    .select('id,name,pct,active,telegram_id')
    .eq('active', true)
    .order('name', { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function getSettings() {
  const { data, error } = await getSupabaseClient()
    .from('settings')
    .select('*')
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateSettings(payload) {
  const existing = await getSettings();

  if (existing?.id) {
    const { data, error } = await getSupabaseClient()
      .from('settings')
      .update(payload)
      .eq('id', existing.id)
      .select('*')
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await getSupabaseClient().from('settings').insert(payload).select('*').single();

  if (error) throw error;
  return data;
}

export async function getAllAttendance() {
  const { data, error } = await getSupabaseClient()
    .from('attendance')
    .select('id,master_id,master,attendance_date,d,arrived,arrived_at,created_at')
    .order('attendance_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function createAttendance(payload) {
  const { data, error } = await getSupabaseClient()
    .from('attendance')
    .insert(payload)
    .select('id,master_id,master,attendance_date,d,arrived,arrived_at,created_at')
    .single();

  if (error) throw error;
  return data;
}

export async function updateAttendance(attendanceId, payload) {
  const { data, error } = await getSupabaseClient()
    .from('attendance')
    .update(payload)
    .eq('id', attendanceId)
    .select('id,master_id,master,attendance_date,d,arrived,arrived_at,created_at')
    .single();

  if (error) throw error;
  return data;
}

export async function deleteAttendance(attendanceId) {
  const { error } = await getSupabaseClient().from('attendance').delete().eq('id', attendanceId);

  if (error) throw error;
}

export async function getSalesForMaster(masterId) {
  if (!masterId) return [];

  const { data, error } = await getSupabaseClient()
    .from('sales')
    .select('id,master_id,master,sale_date,d,cash,card,qr,cl,clients_count,is_new_client,status,created_at')
    .eq('master_id', masterId)
    .order('sale_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function deleteSale(saleId) {
  const { error } = await getSupabaseClient().from('sales').delete().eq('id', saleId);

  if (error) throw error;
}

export async function getAttendanceForMaster(masterId) {
  if (!masterId) return [];

  const { data, error } = await getSupabaseClient()
    .from('attendance')
    .select('id,master_id,master,attendance_date,d,arrived,arrived_at,created_at')
    .eq('master_id', masterId)
    .order('attendance_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function getTodayAttendanceForMaster(masterId) {
  if (!masterId) return null;

  const today = todayLocalDate();
  const { data, error } = await getSupabaseClient()
    .from('attendance')
    .select('id,master_id,master,attendance_date,d,arrived,arrived_at,created_at')
    .eq('master_id', masterId)
    .or(`attendance_date.eq.${today},d.eq.${today}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function createAttendanceForMaster({ currentUser, masterName, arrivedTime }) {
  if (!currentUser?.master_id) {
    throw new Error('У пользователя не указан master_id.');
  }

  const today = todayLocalDate();
  const time = arrivedTime || new Date().toTimeString().slice(0, 5);
  const payload = {
    master_id: currentUser.master_id,
    master: masterName,
    attendance_date: today,
    d: today,
    arrived_at: time,
    arrived: time,
  };

  const { data, error } = await getSupabaseClient()
    .from('attendance')
    .insert(payload)
    .select('id,master_id,master,attendance_date,d,arrived,arrived_at,created_at')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function getFinesForMaster(masterId) {
  if (!masterId) return [];

  const { data, error } = await getSupabaseClient()
    .from('fines')
    .select('id,master_id,master,fine_date,d,amount,reason,created_at')
    .eq('master_id', masterId)
    .order('fine_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function createSaleForMaster({
  currentUser,
  masterName,
  cash,
  card,
  qr,
  clientsCount,
  isNewClient,
}) {
  if (!currentUser?.master_id) {
    throw new Error('У пользователя не указан master_id.');
  }

  const normalizedCash = toMoneyNumber(cash);
  const normalizedCard = toMoneyNumber(card);
  const normalizedQr = toMoneyNumber(qr);
  const normalizedClientsCount = Math.max(1, Number(clientsCount) || 1);
  const saleDate = todayLocalDate();

  if (normalizedCash + normalizedCard + normalizedQr <= 0) {
    throw new Error('Сумма продажи должна быть больше 0.');
  }

  const payload = {
    master_id: currentUser.master_id,
    master: masterName,
    sale_date: saleDate,
    d: saleDate,
    cash: normalizedCash,
    card: normalizedCard,
    qr: normalizedQr,
    clients_count: normalizedClientsCount,
    cl: normalizedClientsCount,
    is_new_client: Boolean(isNewClient),
    status: 'pending',
    created_by_user_id: currentUser.id,
  };

  const { data, error } = await getSupabaseClient()
    .from('sales')
    .insert(payload)
    .select('id,master_id,master,sale_date,d,cash,card,qr,cl,clients_count,is_new_client,status,created_at')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function getPendingSales() {
  const { data, error } = await getSupabaseClient()
    .from('sales')
    .select(
      'id,master_id,master,sale_date,d,cash,card,qr,clients_count,cl,is_new_client,status,created_at,created_by_user_id,approved_by_user_id,approved_at',
    )
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function getAdminSales() {
  const { data, error } = await getSupabaseClient()
    .from('sales')
    .select(
      'id,master_id,master,sale_date,d,cash,card,qr,clients_count,cl,is_new_client,status,created_at,created_by_user_id,approved_by_user_id,approved_at',
    )
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function updateSaleStatus({ saleId, status, currentUser }) {
  if (!['approved', 'rejected'].includes(status)) {
    throw new Error('Статус продажи может быть только approved или rejected.');
  }

  if (!saleId) {
    throw new Error('Не указан saleId.');
  }

  const { data, error } = await getSupabaseClient()
    .from('sales')
    .update({
      status,
      approved_by_user_id: currentUser.id,
      approved_by: currentUser.name,
      approved_at: new Date().toISOString(),
    })
    .eq('id', saleId)
    .select(
      'id,master_id,master,sale_date,d,cash,card,qr,clients_count,cl,is_new_client,status,created_at,created_by_user_id,approved_by_user_id,approved_at',
    )
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function getApprovedSales() {
  const { data, error } = await getSupabaseClient()
    .from('sales')
    .select('id,master_id,master,sale_date,d,cash,card,qr,clients_count,cl,status,created_at')
    .eq('status', 'approved')
    .order('sale_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function getExpenses() {
  const { data, error } = await getSupabaseClient()
    .from('expenses')
    .select('id,date,section,category,name,qty,amount_uzs,usd_rate,minus_from,note,created_at')
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function createExpense(payload) {
  const normalizedPayload = {
    date: payload.date,
    section: payload.section,
    category: payload.category || null,
    name: payload.name,
    qty: payload.qty ? Number(payload.qty) : null,
    amount_uzs: Number(payload.amount_uzs) || 0,
    usd_rate: payload.usd_rate ? Number(payload.usd_rate) : null,
    minus_from: payload.minus_from === 'ishxona' ? null : payload.minus_from || null,
    note: payload.note || null,
    created_by: payload.created_by || null,
  };

  const { data, error } = await getSupabaseClient()
    .from('expenses')
    .insert(normalizedPayload)
    .select('id,date,section,category,name,qty,amount_uzs,usd_rate,minus_from,note,created_at,created_by')
    .single();

  if (error && error.message?.includes("'created_by'")) {
    const { created_by: _createdBy, ...withoutCreatedBy } = normalizedPayload;
    const retry = await getSupabaseClient()
      .from('expenses')
      .insert(withoutCreatedBy)
      .select('id,date,section,category,name,qty,amount_uzs,usd_rate,minus_from,note,created_at')
      .single();

    if (retry.error) throw retry.error;
    return retry.data;
  }

  if (error) {
    throw error;
  }

  return data;
}

export async function deleteExpense(expenseId) {
  const { error } = await getSupabaseClient().from('expenses').delete().eq('id', expenseId);

  if (error) {
    throw error;
  }
}

export async function getFines() {
  const { data, error } = await getSupabaseClient()
    .from('fines')
    .select('id,master_id,master,fine_date,d,amount,reason,created_at')
    .order('fine_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function getAllFines() {
  return getFines();
}

export async function createFine(payload) {
  const normalizedPayload = {
    master_id: payload.master_id,
    master: payload.master,
    fine_date: payload.fine_date,
    d: payload.d,
    amount: Number(payload.amount) || 0,
    reason: payload.reason || null,
    created_by: payload.created_by || null,
  };

  const { data, error } = await getSupabaseClient()
    .from('fines')
    .insert(normalizedPayload)
    .select('id,master_id,master,fine_date,d,amount,reason,created_at')
    .single();

  if (error && error.message?.includes("'created_by'")) {
    const { created_by: _createdBy, ...withoutCreatedBy } = normalizedPayload;
    const retry = await getSupabaseClient()
      .from('fines')
      .insert(withoutCreatedBy)
      .select('id,master_id,master,fine_date,d,amount,reason,created_at')
      .single();

    if (retry.error) throw retry.error;
    return retry.data;
  }

  if (error) throw error;
  return data;
}

export async function deleteFine(fineId) {
  const { error } = await getSupabaseClient().from('fines').delete().eq('id', fineId);

  if (error) throw error;
}

export async function getMasters() {
  const { data, error } = await getSupabaseClient()
    .from('masters')
    .select('id,name,pct,active')
    .order('name', { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function getDebts() {
  const { data, error } = await getSupabaseClient()
    .from('debts')
    .select('id,counterparty,direction,amount,currency,start_date,note,is_closed,created_at,created_by,closed_at')
    .order('is_closed', { ascending: true })
    .order('start_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function createDebt(payload) {
  const normalizedPayload = {
    counterparty: payload.counterparty,
    direction: payload.direction,
    amount: Number(payload.amount) || 0,
    currency: payload.currency,
    start_date: payload.start_date,
    note: payload.note || null,
    is_closed: false,
    created_by: payload.created_by || null,
  };

  const { data, error } = await getSupabaseClient()
    .from('debts')
    .insert(normalizedPayload)
    .select('id,counterparty,direction,amount,currency,start_date,note,is_closed,created_at,created_by,closed_at')
    .single();

  if (error && error.message?.includes("'created_by'")) {
    const { created_by: _createdBy, ...withoutCreatedBy } = normalizedPayload;
    const retry = await getSupabaseClient()
      .from('debts')
      .insert(withoutCreatedBy)
      .select('id,counterparty,direction,amount,currency,start_date,note,is_closed,created_at,closed_at')
      .single();

    if (retry.error) throw retry.error;
    return retry.data;
  }

  if (error) throw error;
  return data;
}

export async function updateDebt(debtId, payload) {
  const { data, error } = await getSupabaseClient()
    .from('debts')
    .update(payload)
    .eq('id', debtId)
    .select('id,counterparty,direction,amount,currency,start_date,note,is_closed,created_at,created_by,closed_at')
    .single();

  if (error) throw error;
  return data;
}

export async function deleteDebt(debtId) {
  const { error } = await getSupabaseClient().from('debts').delete().eq('id', debtId);

  if (error) throw error;
}

export async function getDebtPayments() {
  const { data, error } = await getSupabaseClient()
    .from('debt_payments')
    .select('id,debt_id,date,amount,note,created_at,created_by,payment_method')
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function createDebtPayment(payload) {
  const normalizedPayload = {
    debt_id: payload.debt_id,
    date: payload.date,
    amount: Number(payload.amount) || 0,
    note: payload.note || null,
    payment_method: payload.payment_method || null,
    created_by: payload.created_by || null,
  };

  const { data, error } = await getSupabaseClient()
    .from('debt_payments')
    .insert(normalizedPayload)
    .select('id,debt_id,date,amount,note,created_at,created_by,payment_method')
    .single();

  if (error && (error.message?.includes("'created_by'") || error.message?.includes("'payment_method'"))) {
    const { created_by: _createdBy, payment_method: _paymentMethod, ...fallbackPayload } = normalizedPayload;
    const retry = await getSupabaseClient()
      .from('debt_payments')
      .insert(fallbackPayload)
      .select('id,debt_id,date,amount,note,created_at')
      .single();

    if (retry.error) throw retry.error;
    return retry.data;
  }

  if (error) throw error;
  return data;
}

export async function deleteDebtPayment(paymentId) {
  const { error } = await getSupabaseClient().from('debt_payments').delete().eq('id', paymentId);

  if (error) throw error;
}
