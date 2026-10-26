-- Дежурный по чистоте (owner's decisions of 2026-10-26).
--
-- * One master a day keeps the salon clean the whole day. The owner sets the
--   week ahead every Sunday; only he sets it.
-- * From the start of the duty master's own shift, every two hours, he sends a
--   photo of the salon from the app. A window with no photo when it ends is
--   fined automatically, 50 000 each. A rest shorter than an hour at the end
--   of the shift joins the last window.
-- * A day off does not excuse him: he finds another master who takes his day
--   (a request in the app; accepted, the roster changes everywhere). With
--   nobody found, the day stays his and so do the fines.
-- * The same photo sent twice is refused: the same file, or the same picture
--   saved again (a 256-bit difference hash at most 6 bits apart — strict, so
--   that a new shot from the same spot is never taken for an old one). Photos
--   are kept 30 days and are seen by the owner and the partner.
-- * @Maestro_uzbot tells the duty master the evening before (20:00), reminds
--   him twenty minutes before a window ends without a photo and tells him of a
--   fine; on Sunday from 18:00 it tells the owner if next week is not set.
-- * Fines start on settings.duty_since (owner: Monday 2026-11-02); the days
--   before it are a trial week, with the reminders saying so and no fines.

alter table public.settings
  add column if not exists duty_fine_amount bigint not null default 50000,
  add column if not exists duty_interval_minutes integer not null default 120,
  add column if not exists duty_since date;
alter table public.settings drop constraint if exists settings_duty_check;
alter table public.settings add constraint settings_duty_check
  check (duty_fine_amount between 0 and 10000000 and duty_interval_minutes between 30 and 480);

create table if not exists public.duty_roster (
  day date primary key,
  master_id bigint not null references public.masters (id) on delete restrict,
  -- 'swap' when another master took the day over by agreement.
  source text not null default 'owner' check (source in ('owner', 'swap')),
  set_by_user_id bigint references public.app_users (id) on delete set null,
  -- When this master became the day's duty: windows that ended before it are
  -- not his to answer for.
  updated_at timestamptz not null default now()
);

create table if not exists public.duty_swaps (
  id bigint generated always as identity primary key,
  day date not null,
  from_master_id bigint not null references public.masters (id) on delete restrict,
  to_master_id bigint not null references public.masters (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (from_master_id <> to_master_id)
);
create unique index if not exists duty_swaps_one_pending
  on public.duty_swaps (day, from_master_id, to_master_id) where status = 'pending';

create table if not exists public.duty_photos (
  id bigint generated always as identity primary key,
  day date not null,
  master_id bigint not null references public.masters (id) on delete restrict,
  -- One photo a window; a window is known by its start.
  window_starts_at timestamptz not null unique,
  window_ends_at timestamptz not null,
  taken_at timestamptz not null default now(),
  -- When the phone says the picture was made, if it says.
  shot_at timestamptz,
  storage_path text not null unique,
  sha256 text not null,
  phash bit(256) not null,
  bytes integer
);
create index if not exists duty_photos_day on public.duty_photos (day);

-- What the bot has said, so that each thing is said once.
create table if not exists public.duty_notices (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('eve', 'window', 'fine', 'roster', 'swap')),
  ref text not null,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (kind, ref)
);

alter table public.duty_roster enable row level security;
alter table public.duty_swaps enable row level security;
alter table public.duty_photos enable row level security;
alter table public.duty_notices enable row level security;
revoke all on table public.duty_roster, public.duty_swaps, public.duty_photos, public.duty_notices from public, anon, authenticated;

-- A duty fine is one per window, never one per day like the other two rules.
alter table public.fines add column if not exists duty_window timestamptz;
alter table public.fines drop constraint if exists fines_auto_check;
alter table public.fines add constraint fines_auto_check check (auto is null or auto in ('late', 'no_mark', 'duty'));
drop index if exists public.fines_auto_once_key;
create unique index if not exists fines_auto_once_key on public.fines (master_id, d) where auto in ('late', 'no_mark');
create unique index if not exists fines_duty_window_key on public.fines (duty_window) where auto = 'duty';

-- The photos: private, read only through short-lived links the api signs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('duty-photos', 'duty-photos', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

create or replace function public.maestro_tashkent_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Tashkent')::date
$$;

-- The day's windows: from the duty master's own shift that weekday (the
-- schedule version the day falls in), two hours each; a rest shorter than an
-- hour joins the last one. A day his schedule does not cover runs 10:00–22:00.
create or replace function public.maestro_duty_windows(p_day date)
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

-- Everything the app shows about duty, for every role: the roster from this
-- Monday to next Sunday with each day's hours, who works which day (for the
-- owner's choice and a master's request), today's windows with their photo and
-- fine, and the requests — all of them for the owner and the partner, a
-- master's own for a master. Photos come as times only; the images are signed
-- for the owner and the partner by the api.
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
    select w.window_no, w.master_id, w.starts_at, w.ends_at, photo.taken_at as photo_at,
      exists (select 1 from public.fines as fine where fine.auto = 'duty' and fine.duty_window = w.starts_at) as fined
    from today
    cross join lateral public.maestro_duty_windows(today.day) as w
    left join public.duty_photos as photo on photo.window_starts_at = w.starts_at
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

-- The owner's week: each day a master or nobody. Days already gone stay as
-- they were; a day whose master changes loses its open requests.
create or replace function public.maestro_set_duty_roster(p_days jsonb, p_actor_user_id bigint)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  today date := public.maestro_tashkent_today();
  item jsonb;
  the_day date;
  the_master bigint;
  changed integer := 0;
  touched integer;
begin
  if jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) > 21 then
    return jsonb_build_object('ok', false, 'error', 'invalid_duty_roster');
  end if;
  for item in select value from jsonb_array_elements(p_days) loop
    begin
      the_day := (item ->> 'day')::date;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'invalid_duty_roster');
    end;
    if the_day < today or the_day > today + 21 then
      return jsonb_build_object('ok', false, 'error', 'duty_day_out_of_range');
    end if;
    the_master := nullif(item ->> 'master_id', '')::bigint;
    if the_master is not null and not exists (select 1 from public.masters where id = the_master and active) then
      return jsonb_build_object('ok', false, 'error', 'master_not_active');
    end if;

    if the_master is null then
      delete from public.duty_roster where day = the_day;
    else
      insert into public.duty_roster (day, master_id, source, set_by_user_id, updated_at)
      values (the_day, the_master, 'owner', p_actor_user_id, now())
      on conflict (day) do update
        set master_id = excluded.master_id, source = 'owner',
            set_by_user_id = excluded.set_by_user_id, updated_at = now()
        where public.duty_roster.master_id is distinct from excluded.master_id;
    end if;
    get diagnostics touched = row_count;
    if touched > 0 then
      changed := changed + 1;
      update public.duty_swaps set status = 'cancelled', decided_at = now()
       where day = the_day and status = 'pending';
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'changed', changed);
end;
$$;

-- A request to take over a day, until that day's duty begins.
create or replace function public.maestro_ask_duty_swap(p_day date, p_from_master_id bigint, p_to_master_id bigint)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  holder bigint;
  begins timestamptz;
  swap_id bigint;
begin
  select master_id into holder from public.duty_roster where day = p_day;
  if holder is null or holder <> p_from_master_id then
    return jsonb_build_object('ok', false, 'error', 'duty_not_yours');
  end if;
  select min(w.starts_at) into begins from public.maestro_duty_windows(p_day) as w;
  if begins is null or now() >= begins then
    return jsonb_build_object('ok', false, 'error', 'duty_swap_too_late');
  end if;
  if p_to_master_id is null or p_to_master_id = p_from_master_id
    or not exists (select 1 from public.masters where id = p_to_master_id and active) then
    return jsonb_build_object('ok', false, 'error', 'duty_swap_target');
  end if;

  select id into swap_id from public.duty_swaps
   where day = p_day and from_master_id = p_from_master_id and to_master_id = p_to_master_id and status = 'pending';
  if swap_id is null then
    insert into public.duty_swaps (day, from_master_id, to_master_id)
    values (p_day, p_from_master_id, p_to_master_id)
    returning id into swap_id;
  end if;
  return jsonb_build_object(
    'ok', true,
    'swap_id', swap_id,
    'day', p_day,
    'starts_at', begins,
    'from_name', (select name from public.masters where id = p_from_master_id),
    'to_name', (select name from public.masters where id = p_to_master_id)
  );
end;
$$;

-- The asked master answers. Accepted, the day is his everywhere and the
-- other requests for it close; a request whose day has begun, or whose day
-- is no longer the asker's, cannot be accepted.
create or replace function public.maestro_answer_duty_swap(p_swap_id bigint, p_master_id bigint, p_accept boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  swap public.duty_swaps;
  holder bigint;
  begins timestamptz;
  outcome text;
begin
  select * into swap from public.duty_swaps where id = p_swap_id for update;
  if swap.id is null then return jsonb_build_object('ok', false, 'error', 'duty_swap_not_found'); end if;
  if swap.to_master_id <> p_master_id then return jsonb_build_object('ok', false, 'error', 'duty_swap_not_yours'); end if;
  if swap.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'duty_swap_closed', 'status', swap.status);
  end if;

  select master_id into holder from public.duty_roster where day = swap.day for update;
  select min(w.starts_at) into begins from public.maestro_duty_windows(swap.day) as w;
  if holder is distinct from swap.from_master_id then
    update public.duty_swaps set status = 'cancelled', decided_at = now() where id = swap.id;
    return jsonb_build_object('ok', false, 'error', 'duty_swap_closed', 'status', 'cancelled');
  end if;
  if begins is null or now() >= begins then
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

create or replace function public.maestro_cancel_duty_swap(p_swap_id bigint, p_master_id bigint)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  swap public.duty_swaps;
begin
  select * into swap from public.duty_swaps where id = p_swap_id for update;
  if swap.id is null then return jsonb_build_object('ok', false, 'error', 'duty_swap_not_found'); end if;
  if swap.from_master_id <> p_master_id then return jsonb_build_object('ok', false, 'error', 'duty_swap_not_yours'); end if;
  if swap.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'duty_swap_closed', 'status', swap.status);
  end if;
  update public.duty_swaps set status = 'cancelled', decided_at = now() where id = swap.id;
  return jsonb_build_object('ok', true, 'swap_id', swap.id, 'to_master_id', swap.to_master_id, 'day', swap.day);
end;
$$;

-- A photo for the window that is open now, by the day's duty master. Refused:
-- outside a window, a second one for the window, a picture the phone dates
-- more than a quarter of an hour back, and one already sent (the same file, or
-- a picture within 6 of 256 bits of one from the last 30 days).
create or replace function public.maestro_add_duty_photo(
  p_master_id bigint,
  p_storage_path text,
  p_sha256 text,
  p_phash text,
  p_bytes integer,
  p_shot_at timestamptz
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  today date := public.maestro_tashkent_today();
  holder bigint;
  window_start timestamptz;
  window_end timestamptz;
  hash bit(256);
begin
  select master_id into holder from public.duty_roster where day = today;
  if holder is distinct from p_master_id then
    return jsonb_build_object('ok', false, 'error', 'duty_not_today');
  end if;
  select w.starts_at, w.ends_at into window_start, window_end
    from public.maestro_duty_windows(today) as w
   where now() >= w.starts_at and now() < w.ends_at;
  if window_start is null then
    return jsonb_build_object('ok', false, 'error', 'duty_no_window');
  end if;
  if exists (select 1 from public.duty_photos where window_starts_at = window_start) then
    return jsonb_build_object('ok', false, 'error', 'duty_photo_done');
  end if;
  if p_shot_at is not null and p_shot_at < now() - interval '15 minutes' then
    return jsonb_build_object('ok', false, 'error', 'duty_photo_old');
  end if;
  if coalesce(p_phash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_duty_photo');
  end if;
  hash := ('x' || p_phash)::bit(256);
  if exists (
    select 1 from public.duty_photos as photo
    where photo.day >= today - 30
      and (photo.sha256 = p_sha256 or bit_count(photo.phash # hash) <= 6)
  ) then
    return jsonb_build_object('ok', false, 'error', 'duty_photo_repeat');
  end if;

  insert into public.duty_photos (day, master_id, window_starts_at, window_ends_at, shot_at, storage_path, sha256, phash, bytes)
  values (today, p_master_id, window_start, window_end, p_shot_at, p_storage_path, p_sha256, hash, p_bytes)
  on conflict do nothing;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'duty_photo_done');
  end if;
  return jsonb_build_object('ok', true, 'window_starts_at', window_start, 'window_ends_at', window_end);
end;
$$;

-- Every five minutes: each window of yesterday and today that has ended with
-- no photo is fined once, to the master on duty — unless he became the day's
-- duty only after it ended.
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
     where w.ends_at <= now()
       and w.ends_at > roster.updated_at
       and not exists (select 1 from public.duty_photos as photo where photo.window_starts_at = w.starts_at)
    on conflict do nothing;
    get diagnostics added = row_count;
    fined := fined + added;
  end loop;
  return fined;
end;
$$;

-- What the bot has to say now, each thing once:
--   eve    from 20:00, to tomorrow's duty master;
--   window twenty minutes before a window of today ends with no photo;
--   fine   a duty fine of the last day not yet told;
--   roster on Sunday from 18:00, to the owners, when next week has a day
--          without a duty master.
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
           (select duty_fine_amount from public.settings where id = 1) as amount
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
             'trial', clock.today + 1 < clock.since
           ) as payload
    from clock
    join public.duty_roster as roster on roster.day = clock.today + 1
    where clock.since is not null and clock.at >= time '20:00'
  ),
  open_window as (
    -- Known by its start in epoch seconds: a timestamp's text depends on the
    -- session's time zone, and the cron and the bot run in different ones.
    select 'window'::text, extract(epoch from w.starts_at)::bigint::text, w.master_id,
           jsonb_build_object('starts_at', w.starts_at, 'ends_at', w.ends_at, 'amount', clock.amount, 'trial', clock.today < clock.since)
    from clock
    cross join lateral public.maestro_duty_windows(clock.today) as w
    where clock.since is not null
      and now() >= w.starts_at
      and now() >= w.ends_at - interval '20 minutes'
      and now() < w.ends_at
      and not exists (select 1 from public.duty_photos as photo where photo.window_starts_at = w.starts_at)
  ),
  fine as (
    select 'fine'::text, fine.id::text, fine.master_id,
           jsonb_build_object(
             'starts_at', fine.duty_window,
             'ends_at', coalesce(
               (select w.ends_at from public.maestro_duty_windows(fine.d) as w where w.starts_at = fine.duty_window),
               fine.duty_window + make_interval(mins => coalesce((select duty_interval_minutes from public.settings where id = 1), 120))),
             'amount', fine.amount)
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

create or replace function public.maestro_duty_due()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.maestro_duty_notice_candidates())
      or exists (select 1 from public.duty_photos where day < public.maestro_tashkent_today() - 30)
$$;

-- The notices to send now, each claimed so it goes out once, with where to.
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
    on conflict (kind, ref) do nothing
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

create or replace function public.maestro_duty_notice_done(p_notice_id bigint, p_sent boolean)
returns void
language sql
set search_path = ''
as $$
  update public.duty_notices
     set status = case when p_sent then 'sent' else 'failed' end,
         sent_at = case when p_sent then now() else null end
   where id = p_notice_id
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_tashkent_today()',
    'public.maestro_duty_windows(date)',
    'public.maestro_duty_state(bigint)',
    'public.maestro_set_duty_roster(jsonb, bigint)',
    'public.maestro_ask_duty_swap(date, bigint, bigint)',
    'public.maestro_answer_duty_swap(bigint, bigint, boolean)',
    'public.maestro_cancel_duty_swap(bigint, bigint)',
    'public.maestro_add_duty_photo(bigint, text, text, text, integer, timestamptz)',
    'public.maestro_settle_duty_fines()',
    'public.maestro_duty_notice_candidates()',
    'public.maestro_duty_due()',
    'public.maestro_claim_duty_notices(integer)',
    'public.maestro_duty_notice_done(bigint, boolean)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- Fines are settled in the database itself, so a bot that is down never
-- forgives a window; what the bot says follows every five minutes.
select cron.schedule(
  'maestro-duty-fines',
  '*/5 * * * *',
  $job$ select public.maestro_settle_duty_fines(); $job$
);

select cron.schedule(
  'maestro-duty-notices',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://ivowbhraaistxvoymxpf.supabase.co/functions/v1/booking-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-booking-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'booking_cron_secret')
    ),
    body := '{"action":"duty"}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id
  where public.maestro_duty_due();
  $job$
);
