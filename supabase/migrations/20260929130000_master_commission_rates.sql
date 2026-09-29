-- A master's commission changes on a date, not at the moment someone edits his
-- profile. Every sale already keeps its own commission_pct, so past earnings
-- never move; what has to be right is the rate a NEW sale gets, and that is
-- decided by the sale's own date. A sale for 30 September entered after
-- midnight still earns September's rate; a sale for 1 October earns the new
-- one, whenever it is entered.
--
-- For a master with rows here this table is the source of truth: the trigger
-- stamps each new sale from it, and the nightly job keeps masters.pct (the
-- "45% мастеру" label, and the api's first guess) equal to today's rate.
-- Masters without rows behave exactly as before (masters.pct).
--
-- To change a rate: insert (master_id, pct, effective_from). Do not edit
-- masters.pct alone for a master who has rows here; both the next sale and
-- the nightly job follow this table.

create table if not exists public.master_commission_rates (
  id bigint generated always as identity primary key,
  master_id bigint not null references public.masters (id),
  pct integer not null check (pct between 0 and 100),
  effective_from date not null,
  note text,
  created_at timestamptz not null default now(),
  unique (master_id, effective_from)
);

-- Same stance as every Maestro table: only server-side code reads it.
alter table public.master_commission_rates enable row level security;
revoke all on public.master_commission_rates from anon, authenticated;

create or replace function public.maestro_commission_pct_on(p_master_id bigint, p_day date)
returns integer
language sql
stable
set search_path = ''
as $$
  select r.pct
  from public.master_commission_rates r
  where r.master_id = p_master_id and r.effective_from <= p_day
  order by r.effective_from desc
  limit 1
$$;

-- Security definer so the lookup works whichever role inserts the sale.
create or replace function public.sales_set_commission_pct()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rate integer;
begin
  rate := public.maestro_commission_pct_on(new.master_id, coalesce(new.sale_date, new.d));
  if rate is not null then
    new.commission_pct := rate;
  end if;
  return new;
end;
$$;

-- BEFORE triggers fire in name order, and "set" sorts after "fill", so
-- master_id and sale_date are already filled in. Insert only: approving or
-- rejecting a sale later must never re-price it.
drop trigger if exists trg_sales_set_commission_pct on public.sales;
create trigger trg_sales_set_commission_pct
  before insert on public.sales
  for each row execute function public.sales_set_commission_pct();

create or replace function public.maestro_sync_master_commission(
  p_on date default (now() at time zone 'Asia/Tashkent')::date
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.masters m
     set pct = public.maestro_commission_pct_on(m.id, p_on)
   where public.maestro_commission_pct_on(m.id, p_on) is not null
     and m.pct is distinct from public.maestro_commission_pct_on(m.id, p_on);
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke execute on function public.maestro_commission_pct_on(bigint, date) from public, anon, authenticated;
revoke execute on function public.maestro_sync_master_commission(date) from public, anon, authenticated;

-- The owner's decision of 2026-09-29: from 1 October Жамолиддин goes from 45%
-- to 50% and Мироншох from 40% to 45%. The earlier rate covers every date
-- before that, matching every sale they already have (354 at 45%, 246 at 40%).
insert into public.master_commission_rates (master_id, pct, effective_from, note) values
  (4, 45, '2000-01-01', 'ставка до 01.10.2026'),
  (4, 50, '2026-10-01', 'решение владельца 29.09.2026'),
  (6, 40, '2000-01-01', 'ставка до 01.10.2026'),
  (6, 45, '2026-10-01', 'решение владельца 29.09.2026')
on conflict (master_id, effective_from) do nothing;

-- 19:00 UTC is 00:00 in Tashkent (no daylight saving). A named schedule
-- replaces the job of that name, so re-running this file does not add a second.
select cron.schedule(
  'maestro-commission-sync',
  '0 19 * * *',
  $job$ select public.maestro_sync_master_commission(); $job$
);
