-- Duty photos by zone, checked for cleanliness (owner's decisions of
-- 2026-10-26, the evening after duty went live):
--
-- * In each two-hour window the duty master sends every zone: the kitchen
--   (table, sink, dishes, bin), the bar (counter, floor, waiting area) and the
--   toilet (sink, toilet, floor). The zones live in duty_zones, so one can be
--   added or switched off without code.
-- * A zone that does not fit in one frame takes up to three photos, sent
--   together as one attempt and judged together.
-- * Each attempt is looked at by Claude (duty-photo-check, in the Maestro AI
--   project). One that does not show the zone, or shows it dirty, is not
--   counted: it is kept as rejected with the reason, and the master cleans
--   and sends the zone again. An attempt the check could not look at counts.
-- * Photos are taken in the first hour of each window only (14:00–15:00 for
--   the window 14:00–16:00, owner's decision): two windows can no longer be
--   closed in five minutes, and checks fall one to three hours apart.
-- * A window whose zones are not all counted when its photo hour ends is
--   fined once, 50 000; the bot names the zones still missing.

alter table public.settings add column if not exists duty_photo_minutes integer not null default 60;
alter table public.settings drop constraint if exists settings_duty_photo_minutes_check;
alter table public.settings add constraint settings_duty_photo_minutes_check check (duty_photo_minutes between 15 and 120);

create table if not exists public.duty_zones (
  id text primary key check (id ~ '^[a-z_]{2,20}$'),
  name_ru text not null,
  name_uz text not null,
  -- What must be in order, as the master and the check read it.
  checklist_ru text not null,
  checklist_uz text not null,
  sort smallint not null default 0,
  active boolean not null default true
);
alter table public.duty_zones enable row level security;
revoke all on table public.duty_zones from public, anon, authenticated;

insert into public.duty_zones (id, name_ru, name_uz, checklist_ru, checklist_uz, sort) values
  ('kitchen', 'Кухня', 'Oshxona', 'стол, раковина, посуда, мусорная урна', 'stol, rakovina, idish-tovoq, axlat qutisi', 1),
  ('bar', 'Бар', 'Bar', 'стойка, пол, зона ожидания', 'peshtaxta, pol, kutish joyi', 2),
  ('toilet', 'Туалет', 'Hojatxona', 'раковина, унитаз, пол', 'rakovina, unitaz, pol', 3)
on conflict (id) do nothing;

-- One sending of a zone: its photos, and what the check said.
create table if not exists public.duty_attempts (
  id bigint generated always as identity primary key,
  day date not null,
  master_id bigint not null references public.masters (id) on delete restrict,
  zone text not null references public.duty_zones (id),
  window_starts_at timestamptz not null,
  window_ends_at timestamptz not null,
  status text not null check (status in ('accepted', 'rejected')),
  reason_ru text,
  reason_uz text,
  -- The model that looked at it, or 'unchecked'.
  checked_by text,
  taken_at timestamptz not null default now()
);
-- One counted attempt per zone and window; refused ones are kept beside it.
create unique index if not exists duty_attempts_one_per_zone
  on public.duty_attempts (window_starts_at, zone) where status = 'accepted';
create index if not exists duty_attempts_day on public.duty_attempts (day);
alter table public.duty_attempts enable row level security;
revoke all on table public.duty_attempts from public, anon, authenticated;

-- A photo now belongs to an attempt, and a window holds many photos.
alter table public.duty_photos add column if not exists attempt_id bigint references public.duty_attempts (id) on delete cascade;
alter table public.duty_photos drop constraint if exists duty_photos_window_starts_at_key;
create index if not exists duty_photos_attempt on public.duty_photos (attempt_id);

-- When a window's photo hour ends: its first duty_photo_minutes, or the whole
-- window when it is shorter.
create or replace function public.maestro_duty_photo_until(p_start timestamptz, p_end timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select least(p_end, p_start + make_interval(mins => coalesce((select duty_photo_minutes from public.settings where id = 1), 60)))
$$;

-- The active zones a window still lacks a counted attempt of, as {id, ru, uz}.
create or replace function public.maestro_duty_zones_missing(p_window_start timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', dz.id, 'ru', dz.name_ru, 'uz', dz.name_uz) order by dz.sort), '[]'::jsonb)
  from public.duty_zones as dz
  where dz.active
    and not exists (
      select 1 from public.duty_attempts as attempt
      where attempt.window_starts_at = p_window_start and attempt.zone = dz.id and attempt.status = 'accepted'
    )
$$;

create or replace function public.maestro_duty_window_done(p_window_start timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select jsonb_array_length(public.maestro_duty_zones_missing(p_window_start)) = 0
$$;

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
                         'checklist_ru', dz.checklist_ru, 'checklist_uz', dz.checklist_uz) order by dz.sort)
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

-- Whether a zone may be sent now, before anyone looks at it: the day's duty
-- master, a window in its photo hour, the zone active and not yet counted in it, one to
-- three photos, each dated by the phone within a quarter of an hour and none
-- a picture already sent in the last 30 days (counted or not) or twice in
-- this sending. p_photos: [{sha256, phash, shot_at}].
create or replace function public.maestro_duty_photo_problem(p_master_id bigint, p_zone text, p_photos jsonb)
returns table (problem_code text, window_start timestamptz, window_end timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  today date := public.maestro_tashkent_today();
  holder bigint;
  item jsonb;
  hash bit(256);
  seen text[] := array[]::text[];
begin
  select roster.master_id into holder from public.duty_roster as roster where roster.day = today;
  if holder is distinct from p_master_id then
    problem_code := 'duty_not_today'; return next; return;
  end if;
  select w.starts_at, w.ends_at into window_start, window_end
    from public.maestro_duty_windows(today) as w
   where now() >= w.starts_at and now() < w.ends_at;
  if window_start is null then
    problem_code := 'duty_no_window'; return next; return;
  end if;
  if now() >= public.maestro_duty_photo_until(window_start, window_end) then
    problem_code := 'duty_photo_closed'; return next; return;
  end if;
  if not exists (select 1 from public.duty_zones as dz where dz.id = p_zone and dz.active) then
    problem_code := 'invalid_duty_zone'; return next; return;
  end if;
  if exists (select 1 from public.duty_attempts as attempt
              where attempt.window_starts_at = window_start and attempt.zone = p_zone and attempt.status = 'accepted') then
    problem_code := 'duty_photo_done'; return next; return;
  end if;
  if jsonb_typeof(p_photos) <> 'array' or jsonb_array_length(p_photos) not between 1 and 3 then
    problem_code := 'invalid_duty_photo'; return next; return;
  end if;
  for item in select value from jsonb_array_elements(p_photos) loop
    if coalesce(item ->> 'phash', '') !~ '^[0-9a-f]{64}$' or coalesce(item ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then
      problem_code := 'invalid_duty_photo'; return next; return;
    end if;
    if nullif(item ->> 'shot_at', '') is not null and (item ->> 'shot_at')::timestamptz < now() - interval '15 minutes' then
      problem_code := 'duty_photo_old'; return next; return;
    end if;
    hash := ('x' || (item ->> 'phash'))::bit(256);
    if (item ->> 'phash') = any (seen) or exists (
      select 1 from public.duty_photos as photo
      where photo.day >= today - 30
        and (photo.sha256 = item ->> 'sha256' or bit_count(photo.phash # hash) <= 6)
    ) then
      problem_code := 'duty_photo_repeat'; return next; return;
    end if;
    seen := seen || (item ->> 'phash');
  end loop;
  problem_code := null;
  return next;
end;
$$;

drop function if exists public.maestro_add_duty_photo(bigint, text, text, text, integer, timestamptz);

-- The zone once looked at: an attempt counted, or kept as rejected with its
-- reason, with its photos. The checks run again here, so two taps cannot
-- both count. p_photos: [{storage_path, sha256, phash, bytes, shot_at}].
create or replace function public.maestro_add_duty_attempt(
  p_master_id bigint,
  p_zone text,
  p_photos jsonb,
  p_accepted boolean,
  p_reason_ru text,
  p_reason_uz text,
  p_checked_by text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  problem record;
  counted boolean := coalesce(p_accepted, true);
  new_attempt bigint;
  today date := public.maestro_tashkent_today();
begin
  select * into problem from public.maestro_duty_photo_problem(p_master_id, p_zone, p_photos);
  if problem.problem_code is not null then
    return jsonb_build_object('ok', false, 'error', problem.problem_code);
  end if;

  begin
    insert into public.duty_attempts (day, master_id, zone, window_starts_at, window_ends_at, status, reason_ru, reason_uz, checked_by)
    values (today, p_master_id, p_zone, problem.window_start, problem.window_end,
            case when counted then 'accepted' else 'rejected' end,
            case when counted then null else left(p_reason_ru, 300) end,
            case when counted then null else left(p_reason_uz, 300) end,
            left(p_checked_by, 60))
    returning id into new_attempt;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'duty_photo_done');
  end;

  insert into public.duty_photos (day, master_id, attempt_id, window_starts_at, window_ends_at, shot_at,
                                  storage_path, sha256, phash, bytes)
  select today, p_master_id, new_attempt, problem.window_start, problem.window_end,
         nullif(item ->> 'shot_at', '')::timestamptz, item ->> 'storage_path', item ->> 'sha256',
         ('x' || (item ->> 'phash'))::bit(256), nullif(item ->> 'bytes', '')::integer
    from jsonb_array_elements(p_photos) as item;

  return jsonb_build_object(
    'ok', true,
    'attempt_id', new_attempt,
    'accepted', counted,
    'reason_ru', case when counted then null else p_reason_ru end,
    'reason_uz', case when counted then null else p_reason_uz end,
    'window_starts_at', problem.window_start,
    'window_ends_at', problem.window_end,
    'missing', public.maestro_duty_zones_missing(problem.window_start)
  );
end;
$$;

-- Every five minutes: each window of yesterday and today whose photo hour has
-- ended with a zone still uncounted is fined once, to the master on duty,
-- unless he became the day's duty only after that hour ended.
create or replace function public.maestro_settle_duty_fines()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  config record;
  today date := public.maestro_tashkent_today();
  fined integer := 0;
  added integer;
  the_day date;
begin
  select duty_fine_amount, duty_since into config from public.settings where id = 1;
  if config.duty_since is null or coalesce(config.duty_fine_amount, 0) <= 0 then return 0; end if;

  foreach the_day in array array[today - 1, today] loop
    continue when the_day < config.duty_since;
    insert into public.fines (master, master_id, d, amount, reason, auto, duty_window, created_by)
    select master.name, w.master_id, the_day, config.duty_fine_amount, 'duty', 'duty', w.starts_at, 'auto'
      from public.maestro_duty_windows(the_day) as w
      join public.masters as master on master.id = w.master_id and master.active
      join public.duty_roster as roster on roster.day = the_day
     where public.maestro_duty_photo_until(w.starts_at, w.ends_at) <= now()
       and public.maestro_duty_photo_until(w.starts_at, w.ends_at) > roster.updated_at
       and not public.maestro_duty_window_done(w.starts_at)
    on conflict do nothing;
    get diagnostics added = row_count;
    fined := fined + added;
  end loop;
  return fined;
end;
$$;

-- What the bot has to say now, each thing once; the evening notice lists the
-- zones and the photo hours, the reminder (twenty minutes before a photo hour
-- ends) and the fine the zones still missing.
create or replace function public.maestro_duty_notice_candidates()
returns table (kind text, ref text, master_id bigint, payload jsonb)
language sql
stable
set search_path = ''
as $$
  with clock as (
    select public.maestro_tashkent_today() as today,
           (now() at time zone 'Asia/Tashkent')::time as at,
           (select duty_since from public.settings where id = 1) as since,
           (select duty_fine_amount from public.settings where id = 1) as amount,
           coalesce((select jsonb_agg(jsonb_build_object('id', dz.id, 'ru', dz.name_ru, 'uz', dz.name_uz) order by dz.sort)
                       from public.duty_zones as dz where dz.active), '[]'::jsonb) as zones
  ),
  eve as (
    select 'eve'::text as kind,
           (clock.today + 1)::text || ':' || roster.master_id as ref,
           roster.master_id,
           jsonb_build_object(
             'day', clock.today + 1,
             'starts_at', (select min(w.starts_at) from public.maestro_duty_windows(clock.today + 1) as w),
             'ends_at', (select max(w.ends_at) from public.maestro_duty_windows(clock.today + 1) as w),
             'windows', (select count(*) from public.maestro_duty_windows(clock.today + 1)),
             'amount', clock.amount,
             'trial', clock.today + 1 < clock.since,
             'zones', clock.zones,
             'hours', (select jsonb_agg(jsonb_build_object('starts_at', w.starts_at,
                                                           'until', public.maestro_duty_photo_until(w.starts_at, w.ends_at))
                                        order by w.starts_at)
                         from public.maestro_duty_windows(clock.today + 1) as w)
           ) as payload
    from clock
    join public.duty_roster as roster on roster.day = clock.today + 1
    where clock.since is not null and clock.at >= time '20:00'
  ),
  open_window as (
    -- Known by its start in epoch seconds: a timestamp's text depends on the
    -- session's time zone, and the cron and the bot run in different ones.
    select 'window'::text, extract(epoch from w.starts_at)::bigint::text, w.master_id,
           jsonb_build_object('starts_at', w.starts_at, 'ends_at', public.maestro_duty_photo_until(w.starts_at, w.ends_at),
                              'amount', clock.amount, 'trial', clock.today < clock.since,
                              'missing', public.maestro_duty_zones_missing(w.starts_at))
    from clock
    cross join lateral public.maestro_duty_windows(clock.today) as w
    where clock.since is not null
      and now() >= w.starts_at
      and now() >= public.maestro_duty_photo_until(w.starts_at, w.ends_at) - interval '20 minutes'
      and now() < public.maestro_duty_photo_until(w.starts_at, w.ends_at)
      and not public.maestro_duty_window_done(w.starts_at)
  ),
  fine as (
    select 'fine'::text, fine.id::text, fine.master_id,
           jsonb_build_object(
             'starts_at', fine.duty_window,
             'ends_at', coalesce(
               (select public.maestro_duty_photo_until(w.starts_at, w.ends_at) from public.maestro_duty_windows(fine.d) as w
                 where w.starts_at = fine.duty_window),
               fine.duty_window + make_interval(mins => coalesce((select duty_photo_minutes from public.settings where id = 1), 60))),
             'amount', fine.amount,
             'missing', public.maestro_duty_zones_missing(fine.duty_window))
    from public.fines as fine
    where fine.auto = 'duty' and fine.created_at > now() - interval '1 day'
  ),
  roster_gap as (
    select 'roster'::text,
           (clock.today + 1)::text,
           null::bigint,
           jsonb_build_object(
             'from', clock.today + 1,
             'missing', 7 - (select count(*) from public.duty_roster as roster
                              where roster.day between clock.today + 1 and clock.today + 7))
    from clock
    where clock.since is not null
      and extract(isodow from clock.today) = 7
      and clock.at >= time '18:00'
      and (select count(*) from public.duty_roster as roster where roster.day between clock.today + 1 and clock.today + 7) < 7
  ),
  everything as (
    select * from eve
    union all select * from open_window
    union all select * from fine
    union all select * from roster_gap
  )
  select everything.* from everything
  where not exists (
    select 1 from public.duty_notices as notice
    where notice.kind = everything.kind and notice.ref = everything.ref
  )
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_duty_photo_until(timestamptz, timestamptz)',
    'public.maestro_duty_zones_missing(timestamptz)',
    'public.maestro_duty_window_done(timestamptz)',
    'public.maestro_duty_state(bigint)',
    'public.maestro_duty_photo_problem(bigint, text, jsonb)',
    'public.maestro_add_duty_attempt(bigint, text, jsonb, boolean, text, text, text)',
    'public.maestro_settle_duty_fines()',
    'public.maestro_duty_notice_candidates()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
