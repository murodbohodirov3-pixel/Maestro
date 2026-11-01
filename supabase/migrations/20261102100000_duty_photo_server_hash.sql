-- Audit of 2026-11-01, №12 (owner's «да» of 2026-11-02): the api now takes a
-- photo's fingerprint from the photo it receives, not from the phone. Its own
-- drawing-down differs from the phone's, so a picture saved again lands up to
-- 15 bits from itself (30 real photos re-saved, made smaller), and two
-- different real photos never came closer than 50 (75 photos, the nearest two
-- shot 19 seconds apart): a repeat is now within 24 bits. A fingerprint the
-- phones sent before stays in the base; against the server's it is as good as
-- random (about 128 bits off) and matches nothing. The rest is the check of
-- 20261101120000_duty_audit_fixes.sql unchanged; the function keeps its grants.
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
        and (photo.sha256 = item ->> 'sha256' or bit_count(photo.phash # hash) <= 24)
    ) then
      problem_code := 'duty_photo_repeat'; return next; return;
    end if;
    seen := seen || (item ->> 'phash');
  end loop;
  problem_code := null;
  return next;
end;
$$;
