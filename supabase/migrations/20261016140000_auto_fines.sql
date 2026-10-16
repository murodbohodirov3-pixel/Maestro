-- Discipline, as decided by the owner on 2026-10-16:
--
-- * A late arrival is fined automatically when the master checks in: any
--   minute past his scheduled start plus the grace, 100 000 сум.
-- * By 18:00 every master who is due that day has either an arrival or a day
--   off (the partner, Жамшид, sets days off). Anyone with neither is fined
--   100 000 by the 18:00 job. A day off set later takes that fine back.
-- * A booking whose time has started half an hour ago and is still open sends
--   the master a reminder from the bot, once; a master with a booking that has
--   ended and is still open records no other visit until he closes it.
-- Fines before auto_fines_since are left as they were; amounts live in settings.
-- Bookings before booking_control_since (24 left open from July to September)
-- neither block nor remind: the control starts on the day it is switched on.

alter table public.settings
  add column if not exists late_fine_amount bigint not null default 100000,
  add column if not exists no_mark_fine_amount bigint not null default 100000,
  add column if not exists auto_fines_since date,
  add column if not exists booking_control_since timestamptz;
alter table public.settings drop constraint if exists settings_auto_fine_amounts_check;
alter table public.settings add constraint settings_auto_fine_amounts_check
  check (late_fine_amount between 0 and 10000000 and no_mark_fine_amount between 0 and 10000000);
update public.settings
   set auto_fines_since = coalesce(auto_fines_since, (now() at time zone 'Asia/Tashkent')::date),
       booking_control_since = coalesce(booking_control_since, now())
 where id = 1;

-- Which automatic rule wrote a fine; null for every fine the owner wrote.
alter table public.fines add column if not exists auto text;
alter table public.fines drop constraint if exists fines_auto_check;
alter table public.fines add constraint fines_auto_check check (auto is null or auto in ('late', 'no_mark'));
-- One automatic fine per master and day, whichever rule came first.
create unique index if not exists fines_auto_once_key on public.fines (master_id, d) where auto is not null;

alter table public.appointments add column if not exists master_reminded_at timestamptz;

-- The minute after which an arrival is late, by the same rule as the app's
-- shiftStartFor: before late_rule_since the salon cutoff unless the master's
-- shift starts later; from it, his own scheduled start plus the grace. Null
-- when nothing is late that day.
create or replace function public.maestro_late_threshold(p_master_id bigint, p_day date)
returns integer
language sql
stable
set search_path = ''
as $$
  with config as (
    select
      split_part(coalesce(settings.shift_start, '09:00'), ':', 1)::integer * 60
        + split_part(coalesce(settings.shift_start, '09:00'), ':', 2)::integer as cutoff,
      settings.late_grace_minutes as grace,
      settings.late_rule_since as since
    from public.settings where id = 1
  ),
  start as (
    select min(extract(hour from rule.starts_at)::integer * 60 + extract(minute from rule.starts_at)::integer) as minutes
    from public.master_schedule_rules as rule
    where rule.master_id = p_master_id
      and rule.active
      and rule.iso_weekday = extract(isodow from p_day)::smallint
      and rule.effective_from = public.maestro_schedule_version_on(p_master_id, p_day)
  )
  select case
    when config.since is not null and p_day >= config.since then start.minutes + config.grace
    when start.minutes is null then config.cutoff
    else greatest(config.cutoff, start.minutes)
  end
  from config, start
$$;

-- Called whenever an arrival is written: a master checking himself in, or the
-- owner correcting the sheet. Late → that day's automatic fine (one a day,
-- whichever rule came first); on time → an earlier «опоздание» fine for the
-- day is taken back, since the time it was based on was wrong.
create or replace function public.maestro_settle_late_fine(
  p_master_id bigint,
  p_day date,
  p_arrived text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  config record;
  threshold integer;
  arrived_minutes integer;
  master_name text;
begin
  select late_fine_amount, auto_fines_since into config from public.settings where id = 1;
  if p_master_id is null or p_day is null or coalesce(p_arrived, '') !~ '^\d{2}:\d{2}'
    or config.auto_fines_since is null or p_day < config.auto_fines_since then
    return jsonb_build_object('fined', false);
  end if;

  threshold := public.maestro_late_threshold(p_master_id, p_day);
  arrived_minutes := split_part(p_arrived, ':', 1)::integer * 60 + split_part(p_arrived, ':', 2)::integer;
  if threshold is null or arrived_minutes <= threshold or coalesce(config.late_fine_amount, 0) <= 0 then
    perform public.maestro_drop_auto_fine(p_master_id, p_day, 'late', p_actor_user_id);
    return jsonb_build_object('fined', false);
  end if;

  select name into master_name from public.masters where id = p_master_id;
  insert into public.fines (master, master_id, d, amount, reason, auto, created_by)
  values (master_name, p_master_id, p_day, config.late_fine_amount, 'late', 'late', 'auto')
  on conflict do nothing;
  return jsonb_build_object(
    'fined', true,
    'new', found,
    'amount', config.late_fine_amount,
    'minutes', arrived_minutes - threshold
  );
end;
$$;

-- 18:00 Tashkent: every active master due today by his schedule, with no
-- arrival and no day off, is fined once.
create or replace function public.maestro_fine_missing_marks(
  p_day date default (now() at time zone 'Asia/Tashkent')::date
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  config record;
  fined integer;
begin
  select no_mark_fine_amount, auto_fines_since into config from public.settings where id = 1;
  if config.auto_fines_since is null or p_day < config.auto_fines_since or coalesce(config.no_mark_fine_amount, 0) <= 0 then
    return 0;
  end if;

  insert into public.fines (master, master_id, d, amount, reason, auto, created_by)
  select master.name, master.id, p_day, config.no_mark_fine_amount, 'no_mark', 'no_mark', 'auto'
  from public.masters as master
  where master.active
    and exists (
      select 1 from public.master_schedule_rules as rule
      where rule.master_id = master.id and rule.active
        and rule.iso_weekday = extract(isodow from p_day)::smallint
        and rule.effective_from = public.maestro_schedule_version_on(master.id, p_day)
    )
    and not exists (
      select 1 from public.attendance as arrival
      where (arrival.master_id = master.id or arrival.master = master.name) and arrival.d = p_day
    )
    and not exists (
      select 1 from public.master_day_statuses as day_status
      where day_status.master_id = master.id and day_status.work_date = p_day and day_status.status = 'day_off'
    )
  on conflict do nothing;
  get diagnostics fined = row_count;
  return fined;
end;
$$;

-- Takes back a day's automatic fine of one kind: the «нет отметки» fine when a
-- day off is set after 18:00, the «опоздание» fine when the owner corrects an
-- arrival to on time. The deletion is journalled like any other; the actor may
-- be the partner, so the journal's fields are set here rather than through the
-- owner-only helper.
create or replace function public.maestro_drop_auto_fine(
  p_master_id bigint,
  p_day date,
  p_kind text,
  p_actor_user_id bigint
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  actor record;
  dropped integer;
begin
  select name, role into actor from public.app_users where id = p_actor_user_id and active;
  perform set_config('maestro.audit_actor_user_id', coalesce(p_actor_user_id::text, ''), true);
  perform set_config('maestro.audit_actor_name', coalesce(actor.name, ''), true);
  perform set_config('maestro.audit_actor_role', coalesce(actor.role, ''), true);
  perform set_config('maestro.audit_source', 'auto_fine_' || coalesce(p_kind, ''), true);
  perform set_config('maestro.audit_correlation_id', gen_random_uuid()::text, true);
  delete from public.fines where master_id = p_master_id and d = p_day and auto = p_kind;
  get diagnostics dropped = row_count;
  return dropped;
end;
$$;

-- Open bookings that started half an hour ago and were not yet reminded about:
-- claimed once, with the master's Telegram id.
create or replace function public.maestro_claim_master_reminders(p_limit integer default 25)
returns table (
  appointment_id uuid,
  master_chat_id text,
  client_name text,
  service_name text,
  starts_at timestamptz
)
language sql
set search_path = ''
as $$
  with due as (
    select appointment.id
    from public.appointments as appointment
    where (appointment.status = 'confirmed' or (appointment.status = 'pending' and appointment.source <> 'web'))
      and appointment.master_reminded_at is null
      and appointment.starts_at <= now() - interval '30 minutes'
      and appointment.starts_at > now() - interval '1 day'
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
  )
  select claimed.id,
    coalesce(
      (select app_user.telegram_id::text from public.app_users as app_user
        where app_user.master_id = claimed.master_id and app_user.active and app_user.telegram_id is not null
        limit 1),
      (select master.telegram_id::text from public.masters as master where master.id = claimed.master_id)
    ),
    claimed.client_name, claimed.service_name, claimed.starts_at
  from claimed
$$;

-- A master's bookings that have ended and are still open: until he closes
-- them («Пришёл» → visit, or «Не пришёл»), he records no other visit.
create or replace function public.maestro_unclosed_bookings(p_master_id bigint)
returns table (id uuid, client_name text, starts_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select appointment.id, appointment.client_name, appointment.starts_at
  from public.appointments as appointment
  where appointment.master_id = p_master_id
    and (appointment.status = 'confirmed' or (appointment.status = 'pending' and appointment.source <> 'web'))
    and appointment.ends_at <= now()
    and appointment.starts_at >= coalesce((select booking_control_since from public.settings where id = 1), 'infinity')
  order by appointment.starts_at
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_late_threshold(bigint, date)',
    'public.maestro_settle_late_fine(bigint, date, text, bigint)',
    'public.maestro_fine_missing_marks(date)',
    'public.maestro_drop_auto_fine(bigint, date, text, bigint)',
    'public.maestro_claim_master_reminders(integer)',
    'public.maestro_unclosed_bookings(bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- 13:00 UTC is 18:00 in Tashkent, all year.
select cron.schedule(
  'maestro-no-mark-fines',
  '0 13 * * *',
  $job$ select public.maestro_fine_missing_marks(); $job$
);
