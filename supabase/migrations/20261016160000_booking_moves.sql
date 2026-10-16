-- Moving a booking (owner's request of 2026-10-16): those who book — the
-- owner, the administrator and the partner — move an open booking to another
-- time or another master, by the same rule as a new booking: a free time by
-- the master's schedule. The master hears about it from the bot (the api does
-- the sending).
--
-- Needs 20261015120000_online_booking (maestro_booking_slots with
-- p_except_appointment) and 20261016140000_auto_fines (master_reminded_at).

create or replace function public.maestro_move_appointment(
  p_appointment_id uuid,
  p_master_id bigint,
  p_starts_at timestamptz,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  appointment_record public.appointments;
  previous public.appointments;
  local_date date;
begin
  if p_appointment_id is null or p_master_id is null or p_starts_at is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_booking');
  end if;

  select * into previous from public.appointments where id = p_appointment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'appointment_not_found'); end if;
  if not (previous.status = 'confirmed' or (previous.status = 'pending' and previous.source <> 'web')) then
    return jsonb_build_object('ok', false, 'error', 'appointment_closed');
  end if;
  if previous.master_id = p_master_id and previous.starts_at = p_starts_at then
    return jsonb_build_object('ok', true, 'unchanged', true);
  end if;
  if not exists (select 1 from public.masters where id = p_master_id and active) then
    return jsonb_build_object('ok', false, 'error', 'master_not_active');
  end if;

  local_date := (p_starts_at at time zone 'Asia/Tashkent')::date;
  if not exists (
    select 1
    from public.maestro_booking_slots(previous.duration_minutes, local_date, local_date,
      array[p_master_id], now(), p_appointment_id) as slot
    where slot.slot_start = p_starts_at
  ) then
    return jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  end if;

  begin
    update public.appointments
       set master_id = p_master_id,
           starts_at = p_starts_at,
           ends_at = p_starts_at + make_interval(mins => previous.duration_minutes),
           master_reminded_at = null,
           updated_by_user_id = p_actor_user_id,
           updated_at = now()
     where id = p_appointment_id
    returning * into appointment_record;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  end;

  -- A client's reminder not yet sent is planned again from the new time.
  delete from public.appointment_notification_deliveries
   where appointment_id = p_appointment_id
     and kind in ('reminder_24h', 'reminder_2h')
     and status in ('pending', 'failed');

  insert into public.appointment_events (appointment_id, event_type, old_values, new_values, actor_user_id)
  values (p_appointment_id, 'rescheduled',
    jsonb_build_object('master_id', previous.master_id, 'starts_at', previous.starts_at, 'ends_at', previous.ends_at),
    jsonb_build_object('master_id', appointment_record.master_id, 'starts_at', appointment_record.starts_at, 'ends_at', appointment_record.ends_at),
    p_actor_user_id);

  return jsonb_build_object(
    'ok', true,
    'unchanged', false,
    'appointment', to_jsonb(appointment_record) - 'booking_token_hash' - 'booking_ip_hash' - 'booking_tg_user_id',
    'previous_master_id', previous.master_id,
    'previous_starts_at', previous.starts_at
  );
end;
$$;

revoke execute on function public.maestro_move_appointment(uuid, bigint, timestamptz, bigint) from public, anon, authenticated;
grant execute on function public.maestro_move_appointment(uuid, bigint, timestamptz, bigint) to service_role;
