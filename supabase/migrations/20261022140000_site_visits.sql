-- How many people open the booking page, and how many of them book (owner's
-- request of 2026-10-21). The page asks for the catalogue once when it opens;
-- that request marks the day for the caller's address, kept only as the
-- salted hash the rate limit already uses, and nothing else. One row per
-- address and day, so a page opened ten times is one visitor. Kept 120 days.

create table if not exists public.site_visits (
  day date not null,
  ip_hash text not null,
  first_at timestamptz not null default now(),
  primary key (day, ip_hash)
);
alter table public.site_visits enable row level security;
revoke all on table public.site_visits from public, anon, authenticated;

create or replace function public.maestro_site_visit(p_ip_hash text)
returns void
language sql
set search_path = ''
as $$
  insert into public.site_visits (day, ip_hash)
  values ((now() at time zone 'Asia/Tashkent')::date, p_ip_hash)
  on conflict (day, ip_hash) do nothing
$$;

-- Each of the last days in Tashkent: who opened the page, who chose a time
-- and went on to Telegram (a hold), and who confirmed it there.
create or replace function public.maestro_site_stats(p_days integer)
returns table (day date, visitors integer, started integer, booked integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  today date := (now() at time zone 'Asia/Tashkent')::date;
  span integer := greatest(1, least(coalesce(p_days, 30), 120));
begin
  delete from public.site_visits where day < today - 120;
  return query
  select series.day::date,
         (select count(*) from public.site_visits as visit where visit.day = series.day)::integer,
         (select count(*) from public.appointments as booking
           where booking.source = 'web'
             and (booking.created_at at time zone 'Asia/Tashkent')::date = series.day)::integer,
         (select count(*) from public.appointments as booking
           where booking.source = 'web'
             and (booking.created_at at time zone 'Asia/Tashkent')::date = series.day
             and exists (select 1 from public.appointment_events as event
                          where event.appointment_id = booking.id
                            and event.new_values ->> 'status' = 'confirmed'))::integer
    from generate_series(today - (span - 1), today, interval '1 day') as series (day)
   order by series.day;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_site_visit(text)',
    'public.maestro_site_stats(integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
