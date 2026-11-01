-- Duty after the audit of 2026-11-01 (owner: «да» to every point below).
--
-- №1  A fine the owner deleted came back five minutes later: the settle job
--     saw the window still open and no fine for it. Each window is now fined
--     once and remembered in duty_fined_windows, whatever happens to the fine.
-- №2  The windows were worked out from the duty master's schedule each time,
--     so a schedule saved «from today» moved them after the photos were in
--     and fined windows that had been done. A day's windows are now fixed in
--     duty_day_windows once its first window begins.
-- №4  A photo checked in the last seconds of its hour was refused when it was
--     written, because the write looked at the clock again. The write keeps the
--     window the first look found, with three minutes' grace; a window is
--     fined three minutes after its photo hour.
-- №5  A master who became the day's duty during the day could be fined
--     minutes later. A window is fined only if its photo hour ended at least an
--     hour after he became the duty; he is told at once («Сегодня вы
--     дежурный»); a reminder belongs to the window and the master.
-- №35 A notice the bot failed to send was never sent again: it is tried up to
--     three times.
-- №36 Two masters answering requests for the same day could lock each other:
--     the day is locked first now.
-- №38 A request nobody answers within an hour closes by itself (owner), and
--     the master who asked is told.

-- ------------------------------------------------------------ the windows
create table if not exists public.duty_day_windows (
  day date not null,
  window_no integer not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  fixed_at timestamptz not null default now(),
  primary key (day, window_no)
);
alter table public.duty_day_windows enable row level security;
revoke all on table public.duty_day_windows from public, anon, authenticated;

-- The windows the duty master's schedule gives a day: from his own shift that
-- weekday (the schedule version the day falls in), two hours each; a rest
-- shorter than an hour joins the last one. A day his schedule does not cover
-- runs 10:00–22:00. (The body maestro_duty_windows had before.)
create or replace function public.maestro_duty_windows_planned(p_day date)
returns table (window_no integer, master_id bigint, starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  holder bigint;
  shift_start time;
  shift_end time;
  step integer;
  first_at timestamptz;
  last_at timestamptz;
  total integer;
  whole integer;
  rest integer;
  i integer;
begin
  select roster.master_id into holder from public.duty_roster as roster where roster.day = p_day;
  if holder is null then return; end if;

  select min(rule.starts_at), max(rule.ends_at) into shift_start, shift_end
    from public.master_schedule_rules as rule
   where rule.master_id = holder
     and rule.active
     and rule.iso_weekday = extract(isodow from p_day)::smallint
     and rule.effective_from = public.maestro_schedule_version_on(holder, p_day);
  if shift_start is null or shift_end is null or shift_end <= shift_start then
    shift_start := time '10:00';
    shift_end := time '22:00';
  end if;

  step := coalesce((select settings.duty_interval_minutes from public.settings where settings.id = 1), 120);
  first_at := (p_day + shift_start) at time zone 'Asia/Tashkent';
  last_at := (p_day + shift_end) at time zone 'Asia/Tashkent';
  total := (extract(epoch from last_at - first_at) / 60)::integer;
  whole := total / step;
  rest := total - whole * step;
  if whole = 0 then
    whole := 1;
    rest := 0;
    step := total;
  end if;

  for i in 1..whole loop
    window_no := i;
    master_id := holder;
    starts_at := first_at + make_interval(mins => (i - 1) * step);
    ends_at := case when i = whole and rest < 60 then last_at else first_at + make_interval(mins => i * step) end;
    return next;
  end loop;
  if rest >= 60 then
    window_no := whole + 1;
    master_id := holder;
    starts_at := first_at + make_interval(mins => whole * step);
    ends_at := last_at;
    return next;
  end if;
end;
$$;

-- The day's windows: the fixed ones once the day has begun, the planned ones
-- before; always for the master on duty now.
create or replace function public.maestro_duty_windows(p_day date)
returns table (window_no integer, master_id bigint, starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  holder bigint;
begin
  select roster.master_id into holder from public.duty_roster as roster where roster.day = p_day;
  if holder is null then return; end if;
  if exists (select 1 from public.duty_day_windows as fixed where fixed.day = p_day) then
    return query
      select fixed.window_no, holder, fixed.starts_at, fixed.ends_at
        from public.duty_day_windows as fixed
       where fixed.day = p_day
       order by fixed.window_no;
  else
    return query select planned.window_no, planned.master_id, planned.starts_at, planned.ends_at
      from public.maestro_duty_windows_planned(p_day) as planned;
  end if;
end;
$$;

-- Yesterday's and today's windows are fixed once their first window has begun.
-- Called by the settle job every five minutes, by every photo sent, and by the
-- api before a schedule changes.
create or replace function public.maestro_fix_duty_windows()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  today date := public.maestro_tashkent_today();
  the_day date;
  fixed integer := 0;
  added integer;
begin
  foreach the_day in array array[today - 1, today] loop
    continue when exists (select 1 from public.duty_day_windows as known where known.day = the_day);
    insert into public.duty_day_windows (day, window_no, starts_at, ends_at)
    select the_day, planned.window_no, planned.starts_at, planned.ends_at
      from public.maestro_duty_windows_planned(the_day) as planned
     where (select min(first.starts_at) from public.maestro_duty_windows_planned(the_day) as first) <= now()
    on conflict do nothing;
    get diagnostics added = row_count;
    fixed := fixed + added;
  end loop;
  return fixed;
end;
$$;

-- ------------------------------------------------------------ the fines
create table if not exists public.duty_fined_windows (
  window_start timestamptz primary key,
  master_id bigint not null references public.masters (id) on delete restrict,
  fined_at timestamptz not null default now()
);
alter table public.duty_fined_windows enable row level security;
revoke all on table public.duty_fined_windows from public, anon, authenticated;
create index if not exists duty_fined_windows_master on public.duty_fined_windows (master_id);

insert into public.duty_fined_windows (window_start, master_id, fined_at)
select fine.duty_window, fine.master_id, fine.created_at
  from public.fines as fine
 where fine.auto = 'duty' and fine.duty_window is not null and fine.master_id is not null
on conflict do nothing;

-- Every five minutes: the windows are fixed; requests nobody answered within
-- an hour, or whose day has begun, close; and each window of yesterday and
-- today still missing a zone three minutes after its photo hour is fined
-- once, to the master on duty, if that hour ended at least an hour after he
-- became the duty.
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
  perform public.maestro_fix_duty_windows();

  update public.duty_swaps as swap
     set status = 'expired', decided_at = now()
   where swap.status = 'pending'
     and (swap.created_at <= now() - interval '1 hour'
          or swap.day < today
          or now() >= coalesce((select min(w.starts_at) from public.maestro_duty_windows(swap.day) as w), 'infinity'::timestamptz));

  select duty_fine_amount, duty_since into config from public.settings where id = 1;
  if config.duty_since is null or coalesce(config.duty_fine_amount, 0) <= 0 then return 0; end if;

  foreach the_day in array array[today - 1, today] loop
    continue when the_day < config.duty_since;
    with due as (
      select w.master_id, master.name, w.starts_at
        from public.maestro_duty_windows(the_day) as w
        join public.masters as master on master.id = w.master_id and master.active
        join public.duty_roster as roster on roster.day = the_day
       where public.maestro_duty_photo_until(w.starts_at, w.ends_at) + interval '3 minutes' <= now()
         and public.maestro_duty_photo_until(w.starts_at, w.ends_at) >= roster.updated_at + interval '1 hour'
         and not public.maestro_duty_window_done(w.starts_at)
         and not exists (select 1 from public.duty_fined_windows as settled where settled.window_start = w.starts_at)
    ),
    settled as (
      insert into public.duty_fined_windows (window_start, master_id)
      select due.starts_at, due.master_id from due
      on conflict (window_start) do nothing
      returning window_start
    )
    insert into public.fines (master, master_id, d, amount, reason, auto, duty_window, created_by)
    select due.name, due.master_id, the_day, config.duty_fine_amount, 'duty', 'duty', due.starts_at, 'auto'
      from settled
      join due on due.starts_at = settled.window_start
    on conflict do nothing;
    get diagnostics added = row_count;
    fined := fined + added;
  end loop;
  return fined;
end;
$$;

-- ------------------------------------------------------------ the photos
-- As in 20261028100000_duty_repeat_counted_only.sql, plus the window the api's
-- first look found: given it, the write takes that window up to three minutes
-- after its photo hour, so a check that answers late does not cost a fine.
drop function if exists public.maestro_duty_photo_problem(bigint, text, jsonb);
create or replace function public.maestro_duty_photo_problem(
  p_master_id bigint,
  p_zone text,
  p_photos jsonb,
  p_window_start timestamptz default null
)
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
  if p_window_start is null then
    select w.starts_at, w.ends_at into window_start, window_end
      from public.maestro_duty_windows(today) as w
     where now() >= w.starts_at and now() < w.ends_at;
    if window_start is null then
      problem_code := 'duty_no_window'; return next; return;
    end if;
    if now() >= public.maestro_duty_photo_until(window_start, window_end) then
      problem_code := 'duty_photo_closed'; return next; return;
    end if;
  else
    select w.starts_at, w.ends_at into window_start, window_end
      from public.maestro_duty_windows(today) as w
     where w.starts_at = p_window_start;
    if window_start is null then
      problem_code := 'duty_no_window'; return next; return;
    end if;
    if now() < window_start or now() >= public.maestro_duty_photo_until(window_start, window_end) + interval '3 minutes' then
      problem_code := 'duty_photo_closed'; return next; return;
    end if;
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
    -- Against the counted photos of the last 30 days only (a photo with no
    -- attempt predates the zones and counted).
    if (item ->> 'phash') = any (seen) or exists (
      select 1 from public.duty_photos as photo
        left join public.duty_attempts as attempt on attempt.id = photo.attempt_id
      where photo.day >= today - 30
        and coalesce(attempt.status, 'accepted') = 'accepted'
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

drop function if exists public.maestro_add_duty_attempt(bigint, text, jsonb, boolean, text, text, text);
create or replace function public.maestro_add_duty_attempt(
  p_master_id bigint,
  p_zone text,
  p_photos jsonb,
  p_accepted boolean,
  p_reason_ru text,
  p_reason_uz text,
  p_checked_by text,
  p_window_start timestamptz default null
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
  perform public.maestro_fix_duty_windows();
  select * into problem from public.maestro_duty_photo_problem(p_master_id, p_zone, p_photos, p_window_start);
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

-- ------------------------------------------------------------ the swaps
-- As in 20261027100000_duty.sql, with the day's roster row locked before the
-- request, so that two answers for one day wait for each other in turn.
create or replace function public.maestro_answer_duty_swap(p_swap_id bigint, p_master_id bigint, p_accept boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  swap public.duty_swaps;
  the_day date;
  holder bigint;
  begins timestamptz;
  outcome text;
begin
  select request.day into the_day from public.duty_swaps as request where request.id = p_swap_id;
  if the_day is null then return jsonb_build_object('ok', false, 'error', 'duty_swap_not_found'); end if;
  select master_id into holder from public.duty_roster where day = the_day for update;

  select * into swap from public.duty_swaps where id = p_swap_id for update;
  if swap.to_master_id <> p_master_id then return jsonb_build_object('ok', false, 'error', 'duty_swap_not_yours'); end if;
  if swap.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'duty_swap_closed', 'status', swap.status);
  end if;

  select min(w.starts_at) into begins from public.maestro_duty_windows(swap.day) as w;
  if holder is distinct from swap.from_master_id then
    update public.duty_swaps set status = 'cancelled', decided_at = now() where id = swap.id;
    return jsonb_build_object('ok', false, 'error', 'duty_swap_closed', 'status', 'cancelled');
  end if;
  if begins is null or now() >= begins or swap.created_at <= now() - interval '1 hour' then
    update public.duty_swaps set status = 'expired', decided_at = now() where id = swap.id;
    return jsonb_build_object('ok', false, 'error', 'duty_swap_too_late');
  end if;

  if p_accept then
    update public.duty_roster
       set master_id = swap.to_master_id, source = 'swap', set_by_user_id = null, updated_at = now()
     where day = swap.day;
    update public.duty_swaps set status = 'cancelled', decided_at = now()
     where day = swap.day and status = 'pending' and id <> swap.id;
    outcome := 'accepted';
  else
    outcome := 'declined';
  end if;
  update public.duty_swaps set status = outcome, decided_at = now() where id = swap.id;

  return jsonb_build_object(
    'ok', true,
    'status', outcome,
    'swap_id', swap.id,
    'day', swap.day,
    'from_master_id', swap.from_master_id,
    'to_master_id', swap.to_master_id,
    'from_name', (select name from public.masters where id = swap.from_master_id),
    'to_name', (select name from public.masters where id = swap.to_master_id)
  );
end;
$$;

-- ------------------------------------------------------------ the notices
alter table public.duty_notices add column if not exists attempts integer not null default 1;

-- As in 20261027120000_duty_zones.sql, and: a master made today's duty hears it
-- at once; a reminder is the window's and the master's; a request closed
-- unanswered is told to the master who asked; a notice that failed or stuck is
-- offered again, three tries in all.
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
  eve_today as (
    -- Made the duty today, or not told last evening: today's hours still ahead.
    select 'eve'::text, clock.today::text || ':' || roster.master_id, roster.master_id,
           jsonb_build_object(
             'day', clock.today,
             'today', true,
             'starts_at', (select min(w.starts_at) from public.maestro_duty_windows(clock.today) as w),
             'ends_at', (select max(w.ends_at) from public.maestro_duty_windows(clock.today) as w),
             'windows', (select count(*) from public.maestro_duty_windows(clock.today)),
             'amount', clock.amount,
             'trial', clock.today < clock.since,
             'zones', clock.zones,
             'hours', (select jsonb_agg(jsonb_build_object('starts_at', w.starts_at,
                                                           'until', public.maestro_duty_photo_until(w.starts_at, w.ends_at))
                                        order by w.starts_at)
                         from public.maestro_duty_windows(clock.today) as w
                        where public.maestro_duty_photo_until(w.starts_at, w.ends_at) > now())
           )
    from clock
    join public.duty_roster as roster on roster.day = clock.today
    where clock.since is not null
      and now() < (select max(public.maestro_duty_photo_until(w.starts_at, w.ends_at)) from public.maestro_duty_windows(clock.today) as w)
  ),
  open_window as (
    -- Known by its start in epoch seconds (a timestamp's text depends on the
    -- session's time zone, and the cron and the bot run in different ones) and
    -- by the master, so that a master who took the day over is reminded too.
    select 'window'::text, extract(epoch from w.starts_at)::bigint::text || ':' || w.master_id, w.master_id,
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
      -- Reminded before this change, under the window alone.
      and not exists (select 1 from public.duty_notices as old
                       where old.kind = 'window' and old.ref = extract(epoch from w.starts_at)::bigint::text)
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
  swap_closed as (
    select 'swap'::text, 'expired:' || swap.id, swap.from_master_id,
           jsonb_build_object('day', swap.day,
                              'to_name', (select master.name from public.masters as master where master.id = swap.to_master_id))
    from public.duty_swaps as swap, clock
    where swap.status = 'expired'
      and swap.decided_at > now() - interval '1 day'
      and swap.day >= clock.today
      and exists (select 1 from public.duty_roster as roster where roster.day = swap.day and roster.master_id = swap.from_master_id)
  ),
  everything as (
    select * from eve
    union all select * from eve_today
    union all select * from open_window
    union all select * from fine
    union all select * from roster_gap
    union all select * from swap_closed
  )
  select everything.* from everything
  where not exists (
    select 1 from public.duty_notices as notice
    where notice.kind = everything.kind and notice.ref = everything.ref
      and (notice.status = 'sent'
           or notice.attempts >= 3
           or (notice.status = 'claimed' and notice.created_at > now() - interval '10 minutes'))
  )
$$;

-- As in 20261027100000_duty.sql; a notice that failed, or was claimed ten
-- minutes ago and never answered, is claimed again.
create or replace function public.maestro_claim_duty_notices(p_limit integer default 50)
returns table (notice_id bigint, kind text, chat_id text, lang text, master_name text, payload jsonb)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select candidate.* from public.maestro_duty_notice_candidates() as candidate
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ),
  made as (
    insert into public.duty_notices (kind, ref)
    select picked.kind, picked.ref from picked
    on conflict (kind, ref) do update
      set status = 'claimed', created_at = now(), sent_at = null, attempts = public.duty_notices.attempts + 1
      where public.duty_notices.status <> 'sent'
        and public.duty_notices.attempts < 3
        and (public.duty_notices.status = 'failed' or public.duty_notices.created_at <= now() - interval '10 minutes')
    returning duty_notices.id, duty_notices.kind, duty_notices.ref
  )
  select made.id, made.kind, target.chat_id, target.lang,
         (select master.name from public.masters as master where master.id = picked.master_id),
         picked.payload
    from made
    join picked on picked.kind = made.kind and picked.ref = made.ref
    cross join lateral (
      select coalesce(
               (select app_user.telegram_id::text from public.app_users as app_user
                 where app_user.master_id = picked.master_id and app_user.active and app_user.telegram_id is not null limit 1),
               (select master.telegram_id::text from public.masters as master where master.id = picked.master_id)) as chat_id,
             coalesce(
               (select app_user.lang from public.app_users as app_user
                 where app_user.master_id = picked.master_id and app_user.active limit 1), 'ru') as lang
      where picked.master_id is not null
      union all
      select owner.telegram_id::text, coalesce(owner.lang, 'ru')
        from public.app_users as owner
       where picked.master_id is null and owner.role = 'owner' and owner.active and owner.telegram_id is not null
    ) as target;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_duty_windows_planned(date)',
    'public.maestro_duty_windows(date)',
    'public.maestro_fix_duty_windows()',
    'public.maestro_settle_duty_fines()',
    'public.maestro_duty_photo_problem(bigint, text, jsonb, timestamptz)',
    'public.maestro_add_duty_attempt(bigint, text, jsonb, boolean, text, text, text, timestamptz)',
    'public.maestro_answer_duty_swap(bigint, bigint, boolean)',
    'public.maestro_duty_notice_candidates()',
    'public.maestro_claim_duty_notices(integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- Today's windows, if the day has begun, are fixed as they stand now.
select public.maestro_fix_duty_windows();
