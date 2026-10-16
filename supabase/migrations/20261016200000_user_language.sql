-- Each person's language (owner's decision of 2026-10-16): Russian or Uzbek
-- (Latin). The app shows its screens in it, and the bot writes a master his
-- booking notices and reminders in it.
alter table public.app_users add column if not exists lang text not null default 'ru';
alter table public.app_users drop constraint if exists app_users_lang_check;
alter table public.app_users add constraint app_users_lang_check check (lang in ('ru', 'uz'));

-- The master's reminders now carry his language.
drop function if exists public.maestro_claim_master_reminders(integer);
create or replace function public.maestro_claim_master_reminders(p_limit integer default 25)
returns table (
  appointment_id uuid,
  master_chat_id text,
  master_lang text,
  client_name text,
  service_name text,
  starts_at timestamptz,
  ends_at timestamptz
)
language sql
set search_path = ''
as $$
  with due as (
    select appointment.id
    from public.appointments as appointment
    where (appointment.status = 'confirmed' or (appointment.status = 'pending' and appointment.source <> 'web'))
      and appointment.master_reminded_at is null
      and appointment.ends_at <= now() - interval '15 minutes'
      and appointment.ends_at > now() - interval '1 day'
      and appointment.starts_at >= coalesce((select booking_control_since from public.settings where id = 1), 'infinity')
    order by appointment.starts_at
    limit greatest(1, least(coalesce(p_limit, 25), 50))
    for update skip locked
  ), claimed as (
    update public.appointments as appointment
       set master_reminded_at = now()
      from due
     where appointment.id = due.id
    returning appointment.*
  ), login as (
    select distinct on (app_user.master_id) app_user.master_id, app_user.telegram_id::text as chat_id, app_user.lang
    from public.app_users as app_user
    where app_user.active and app_user.telegram_id is not null and app_user.master_id is not null
    order by app_user.master_id, app_user.id
  )
  select claimed.id,
    coalesce(login.chat_id, (select master.telegram_id::text from public.masters as master where master.id = claimed.master_id)),
    coalesce(login.lang, 'ru'),
    claimed.client_name, claimed.service_name, claimed.starts_at, claimed.ends_at
  from claimed
  left join login on login.master_id = claimed.master_id
$$;
revoke execute on function public.maestro_claim_master_reminders(integer) from public, anon, authenticated;
grant execute on function public.maestro_claim_master_reminders(integer) to service_role;
