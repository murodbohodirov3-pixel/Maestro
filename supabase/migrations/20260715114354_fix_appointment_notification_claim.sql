create or replace function public.maestro_claim_due_appointment_notifications(p_limit integer default 25)
returns table (
  notification_id uuid,
  notification_claim_token uuid,
  appointment_id uuid,
  kind text,
  telegram_chat_id text,
  client_name text,
  service_name text,
  master_name text,
  starts_at timestamptz,
  language text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  safe_limit integer := greatest(1, least(coalesce(p_limit, 25), 50));
begin
  insert into public.appointment_notification_deliveries (
    appointment_id, kind, scheduled_for
  )
  select candidate.appointment_id, candidate.kind, candidate.scheduled_for
  from (
    select appointment.id as appointment_id,
      'reminder_24h'::text as kind,
      appointment.starts_at - interval '24 hours' as scheduled_for
    from public.appointments as appointment
    join public.clients as client on client.id = appointment.client_id
    where appointment.source = 'bot'
      and appointment.status = 'confirmed'
      and client.telegram_user_id is not null
      and appointment.starts_at > now() + interval '22 hours'
      and appointment.starts_at <= now() + interval '24 hours'

    union all

    select appointment.id,
      'reminder_2h'::text,
      appointment.starts_at - interval '2 hours'
    from public.appointments as appointment
    join public.clients as client on client.id = appointment.client_id
    where appointment.source = 'bot'
      and appointment.status = 'confirmed'
      and client.telegram_user_id is not null
      and appointment.starts_at > now() + interval '15 minutes'
      and appointment.starts_at <= now() + interval '2 hours'

    union all

    select appointment.id,
      'feedback'::text,
      completed.completed_at + interval '2 hours'
    from public.appointments as appointment
    join public.clients as client on client.id = appointment.client_id
    join lateral (
      select max(event.created_at) as completed_at
      from public.appointment_events as event
      where event.appointment_id = appointment.id
        and event.event_type = 'status_changed'
        and event.new_values ->> 'status' = 'completed'
    ) as completed on completed.completed_at is not null
    where appointment.source = 'bot'
      and appointment.status = 'completed'
      and client.telegram_user_id is not null
      and completed.completed_at <= now() - interval '2 hours'
      and completed.completed_at > now() - interval '24 hours'
  ) as candidate
  on conflict on constraint appointment_notification_deliveries_appointment_id_kind_key do update
  set scheduled_for = excluded.scheduled_for,
      updated_at = now()
  where public.appointment_notification_deliveries.status in ('pending', 'failed')
    and public.appointment_notification_deliveries.sent_at is null;

  update public.appointment_notification_deliveries as delivery
  set status = 'suppressed',
      claim_token = null,
      claimed_at = null,
      claim_expires_at = null,
      updated_at = now()
  from public.appointments as appointment
  where delivery.appointment_id = appointment.id
    and delivery.status in ('pending', 'processing', 'failed')
    and (
      (delivery.kind in ('reminder_24h', 'reminder_2h')
        and (appointment.status <> 'confirmed' or appointment.source <> 'bot'))
      or (delivery.kind = 'feedback'
        and (appointment.status <> 'completed' or appointment.source <> 'bot'))
    );

  return query
  with due as (
    select delivery.id
    from public.appointment_notification_deliveries as delivery
    join public.appointments as appointment on appointment.id = delivery.appointment_id
    join public.clients as client on client.id = appointment.client_id
    where client.telegram_user_id is not null
      and delivery.attempts < 5
      and delivery.scheduled_for <= now()
      and coalesce(delivery.next_attempt_at, delivery.scheduled_for) <= now()
      and (
        delivery.status in ('pending', 'failed')
        or (delivery.status = 'processing' and delivery.claim_expires_at < now())
      )
      and (
        (delivery.kind = 'reminder_24h'
          and appointment.status = 'confirmed'
          and appointment.starts_at > now() + interval '22 hours'
          and appointment.starts_at <= now() + interval '24 hours')
        or (delivery.kind = 'reminder_2h'
          and appointment.status = 'confirmed'
          and appointment.starts_at > now() + interval '15 minutes'
          and appointment.starts_at <= now() + interval '2 hours')
        or (delivery.kind = 'feedback' and appointment.status = 'completed')
      )
    order by delivery.scheduled_for, delivery.id
    for update of delivery skip locked
    limit safe_limit
  ), claimed as (
    update public.appointment_notification_deliveries as delivery
    set status = 'processing',
        attempts = delivery.attempts + 1,
        claim_token = gen_random_uuid(),
        claimed_at = now(),
        claim_expires_at = now() + interval '10 minutes',
        last_error = null,
        updated_at = now()
    from due
    where delivery.id = due.id
    returning delivery.*
  )
  select claimed.id,
    claimed.claim_token,
    appointment.id,
    claimed.kind,
    client.telegram_user_id,
    appointment.client_name,
    appointment.service_name,
    master.name,
    appointment.starts_at,
    case when client.preferred_language in ('ru', 'uz')
      then client.preferred_language else 'ru' end
  from claimed
  join public.appointments as appointment on appointment.id = claimed.appointment_id
  join public.clients as client on client.id = appointment.client_id
  join public.masters as master on master.id = appointment.master_id
  order by claimed.scheduled_for, claimed.id;
end;
$$;
