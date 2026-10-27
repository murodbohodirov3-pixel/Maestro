-- A repeat is a picture already counted, not one the check refused (owner's
-- decision of 2026-10-28). On 27.10 the duty master was told 17 times «Это
-- фото уже присылали» while retaking a zone after a refusal: the new shot of
-- the same corner came close to the refused one, and a photo sent to the wrong
-- zone could not be sent to the right one. A refused picture counted for
-- nothing and is looked at again if sent again; an old clean picture still
-- cannot pass for a new one. Only the repeat test changes.

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

revoke execute on function public.maestro_duty_photo_problem(bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.maestro_duty_photo_problem(bigint, text, jsonb) to service_role;
