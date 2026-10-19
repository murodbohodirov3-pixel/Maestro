-- A site booking is a client's own, confirmed from his own Telegram with his
-- own number. On 2026-10-18 Жамолиддин booked a client on the site from his
-- phone: the card took his number and his Telegram, and «Написать» on it
-- opened Жамолиддин. Staff do not book through the site (owner's decision of
-- 2026-10-19: the administrator books the clients who call or write). A hold
-- confirmed from a staff account is let go at once, and no card is touched.
-- Only the confirmation changes; everything below the new check is as before.

create or replace function public.maestro_confirm_booking(
  p_appointment_id uuid,
  p_tg_user_id text,
  p_phone text,
  p_tg_username text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  appointment_record public.appointments;
  phone text;
  resolved_client_id uuid;
  client_status text;
  master_record record;
begin
  select * into appointment_record from public.appointments where id = p_appointment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if appointment_record.booking_tg_user_id is distinct from p_tg_user_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if appointment_record.status = 'confirmed' then
    return jsonb_build_object('ok', true, 'already_confirmed', true,
      'booking', public.maestro_booking_view(appointment_record));
  end if;
  if appointment_record.status <> 'pending' or appointment_record.hold_expires_at <= now() then
    perform public.maestro_expire_booking_holds();
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  -- A staff account: the time goes back to the site now, not in ten minutes.
  if exists (select 1 from public.app_users where active and telegram_id::text = p_tg_user_id) then
    update public.appointments set hold_expires_at = now(), updated_at = now()
     where id = appointment_record.id;
    perform public.maestro_expire_booking_holds();
    return jsonb_build_object('ok', false, 'error', 'staff_account',
      'lang', coalesce(appointment_record.booking_lang, 'ru'));
  end if;

  phone := coalesce(
    public.maestro_normalize_phone(p_phone),
    (select phone_e164 from public.clients where telegram_user_id = p_tg_user_id)
  );
  if phone is null then return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;

  select lifecycle_status into client_status from public.clients where phone_e164 = phone;
  if client_status = 'blocked' then
    update public.appointments
       set status = 'cancelled', cancelled_by = 'salon', status_reason_code = 'salon_other',
           status_reason_note = 'Клиент заблокирован', cancelled_at = now(), updated_at = now()
     where id = appointment_record.id;
    return jsonb_build_object('ok', false, 'error', 'client_blocked');
  end if;

  -- The Telegram account now belongs to this number; an older card that
  -- carried it under another number lets go of it.
  update public.clients set telegram_user_id = null, updated_at = now()
   where telegram_user_id = p_tg_user_id and phone_e164 <> phone;

  resolved_client_id := public.maestro_upsert_client(
    appointment_record.client_name, phone, 'web', p_tg_user_id, p_tg_username,
    coalesce(appointment_record.booking_lang, 'unknown'), null
  );
  if resolved_client_id is null then return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;

  update public.appointments
     set status = 'confirmed', client_id = resolved_client_id, client_phone = phone,
         hold_expires_at = null, updated_at = now()
   where id = appointment_record.id
  returning * into appointment_record;

  insert into public.appointment_events (appointment_id, event_type, old_values, new_values)
  values (appointment_record.id, 'status_changed', jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'confirmed', 'client_id', resolved_client_id));
  insert into public.client_events (client_id, event_type, source, appointment_id, details)
  values (resolved_client_id, 'appointment_created', 'web', appointment_record.id,
    jsonb_build_object('status', 'confirmed'));

  select master.name,
    coalesce(
      (select app_user.telegram_id::text from public.app_users as app_user
        where app_user.master_id = master.id and app_user.active and app_user.telegram_id is not null
        limit 1),
      master.telegram_id::text
    ) as chat_id
  into master_record
  from public.masters as master where master.id = appointment_record.master_id;

  return jsonb_build_object(
    'ok', true,
    'already_confirmed', false,
    'appointment_id', appointment_record.id,
    'booking', public.maestro_booking_view(appointment_record),
    'master_name', master_record.name,
    'master_chat_id', master_record.chat_id,
    'service_name', appointment_record.service_name,
    'client_name', appointment_record.client_name,
    'client_phone', phone,
    'comment', appointment_record.notes,
    'lang', coalesce(appointment_record.booking_lang, 'ru')
  );
end;
$$;

revoke execute on function public.maestro_confirm_booking(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.maestro_confirm_booking(uuid, text, text, text) to service_role;
