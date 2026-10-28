-- The bins become zones of their own (owner's decisions of 2026-10-28). The
-- duty master photographed the kitchen bin once a day, when it was empty, and
-- framed it out afterwards; the toilet bin was on no list at all. Now every
-- window owes «Урна на кухне» and «Урна в туалете», each with its lid open so
-- the inside shows; a bin is refused only when it is full or overflowing.
--
-- A zone added later is not owed by windows that began before it:
-- duty_zones.counts_from, null for the first three. Without it every window of
-- the trial week before today would read as missing two bins.

alter table public.duty_zones add column if not exists counts_from timestamptz;

update public.duty_zones
set checklist_ru = 'стол, раковина, посуда', checklist_uz = 'stol, rakovina, idish-tovoq'
where id = 'kitchen';

insert into public.duty_zones (id, name_ru, name_uz, checklist_ru, checklist_uz, sort, counts_from) values
  ('kitchen_bin', 'Урна на кухне', 'Oshxonadagi axlat qutisi',
   'урна с открытой крышкой, чтобы было видно, что внутри',
   'qopqogʻi ochiq axlat qutisi, ichi koʻrinsin', 2, now()),
  ('toilet_bin', 'Урна в туалете', 'Hojatxonadagi axlat qutisi',
   'урна с открытой крышкой, чтобы было видно, что внутри',
   'qopqogʻi ochiq axlat qutisi, ichi koʻrinsin', 5, now())
on conflict (id) do nothing;

-- Kitchen, its bin, bar, toilet, its bin.
update public.duty_zones set sort = 3 where id = 'bar';
update public.duty_zones set sort = 4 where id = 'toilet';

-- The active zones a window still lacks a counted attempt of, as {id, ru, uz};
-- a zone counts from its counts_from on.
create or replace function public.maestro_duty_zones_missing(p_window_start timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', dz.id, 'ru', dz.name_ru, 'uz', dz.name_uz) order by dz.sort), '[]'::jsonb)
  from public.duty_zones as dz
  where dz.active
    and (dz.counts_from is null or dz.counts_from <= p_window_start)
    and not exists (
      select 1 from public.duty_attempts as attempt
      where attempt.window_starts_at = p_window_start and attempt.zone = dz.id and attempt.status = 'accepted'
    )
$$;

-- As in 20261027120000_duty_zones.sql, with each zone's counts_from for the
-- screens (zonesFor in src/utils/duty.js).
create or replace function public.maestro_duty_state(p_master_id bigint default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with today as (select public.maestro_tashkent_today() as day),
  span as (
    select generate_series(
      today.day - (extract(isodow from today.day)::integer - 1),
      today.day - (extract(isodow from today.day)::integer - 1) + 13,
      interval '1 day'
    )::date as day
    from today
  ),
  roster as (
    select span.day, roster.master_id, roster.source,
      (select min(w.starts_at) from public.maestro_duty_windows(span.day) as w) as starts_at,
      (select max(w.ends_at) from public.maestro_duty_windows(span.day) as w) as ends_at,
      (select count(*) from public.maestro_duty_windows(span.day)) as windows
    from span
    join public.duty_roster as roster on roster.day = span.day
  ),
  working as (
    select span.day, master.id as master_id
    from span
    cross join public.masters as master
    where master.active
      and exists (
        select 1 from public.master_schedule_rules as rule
        where rule.master_id = master.id and rule.active
          and rule.iso_weekday = extract(isodow from span.day)::smallint
          and rule.effective_from = public.maestro_schedule_version_on(master.id, span.day)
      )
      and not exists (
        select 1 from public.master_day_statuses as day_status
        where day_status.master_id = master.id and day_status.work_date = span.day and day_status.status = 'day_off'
      )
  ),
  windows as (
    select w.window_no, w.master_id, w.starts_at, w.ends_at,
      public.maestro_duty_photo_until(w.starts_at, w.ends_at) as photo_until,
      -- Done when every zone has its counted attempt: the time of the last.
      case when public.maestro_duty_window_done(w.starts_at) then
        (select max(attempt.taken_at) from public.duty_attempts as attempt
          where attempt.window_starts_at = w.starts_at and attempt.status = 'accepted')
      end as photo_at,
      coalesce((select jsonb_agg(attempt.zone order by attempt.zone) from public.duty_attempts as attempt
                 where attempt.window_starts_at = w.starts_at and attempt.status = 'accepted'), '[]'::jsonb) as zones_done,
      -- A zone's last refusal, while it still has no counted attempt.
      coalesce((select jsonb_object_agg(last_try.zone, jsonb_build_object(
                  'reason_ru', last_try.reason_ru, 'reason_uz', last_try.reason_uz, 'at', last_try.taken_at))
                from (select distinct on (attempt.zone) attempt.zone, attempt.reason_ru, attempt.reason_uz, attempt.taken_at
                        from public.duty_attempts as attempt
                       where attempt.window_starts_at = w.starts_at and attempt.status = 'rejected'
                         and not exists (select 1 from public.duty_attempts as counted
                                          where counted.window_starts_at = w.starts_at and counted.zone = attempt.zone
                                            and counted.status = 'accepted')
                       order by attempt.zone, attempt.taken_at desc) as last_try), '{}'::jsonb) as zones_rejected,
      exists (select 1 from public.fines as fine where fine.auto = 'duty' and fine.duty_window = w.starts_at) as fined
    from today
    cross join lateral public.maestro_duty_windows(today.day) as w
  ),
  swaps as (
    select swap.*
    from public.duty_swaps as swap, today
    where swap.day >= today.day - 1
      and (swap.status = 'pending' or swap.decided_at > now() - interval '3 days')
      and (p_master_id is null or p_master_id in (swap.from_master_id, swap.to_master_id))
  )
  select jsonb_build_object(
    'today', (select day from today),
    'now', now(),
    'fine_amount', (select duty_fine_amount from public.settings where id = 1),
    'interval_minutes', (select duty_interval_minutes from public.settings where id = 1),
    -- Fines start on this day; before it the week is a trial.
    'since', (select duty_since from public.settings where id = 1),
    'photos_per_zone', 3,
    'zones', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', dz.id, 'name_ru', dz.name_ru, 'name_uz', dz.name_uz,
                         'checklist_ru', dz.checklist_ru, 'checklist_uz', dz.checklist_uz,
                         'counts_from', dz.counts_from) order by dz.sort)
                       from public.duty_zones as dz where dz.active), '[]'::jsonb),
    'masters', coalesce((select jsonb_agg(jsonb_build_object('id', master.id, 'name', master.name) order by master.id)
                           from public.masters as master where master.active), '[]'::jsonb),
    'roster', coalesce((select jsonb_agg(to_jsonb(roster) order by roster.day) from roster), '[]'::jsonb),
    'working', coalesce((select jsonb_object_agg(grouped.day, grouped.ids)
                           from (select working.day, jsonb_agg(working.master_id order by working.master_id) as ids
                                   from working group by working.day) as grouped), '{}'::jsonb),
    'windows', coalesce((select jsonb_agg(to_jsonb(windows) order by windows.starts_at) from windows), '[]'::jsonb),
    'swaps', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', swaps.id, 'day', swaps.day, 'from_master_id', swaps.from_master_id,
                         'to_master_id', swaps.to_master_id, 'status', swaps.status,
                         'created_at', swaps.created_at, 'decided_at', swaps.decided_at) order by swaps.id desc)
                       from swaps), '[]'::jsonb)
  )
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_duty_zones_missing(timestamptz)',
    'public.maestro_duty_state(bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
