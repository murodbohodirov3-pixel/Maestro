-- Lock every existing payout to the percentage that was active before any
-- future profile edits.  New sales receive their own snapshot in api/addSale.
alter table public.sales
  add column if not exists commission_pct integer;

update public.sales as sale
set commission_pct = master.pct
from public.masters as master
where sale.commission_pct is null
  and sale.master_id = master.id;

update public.sales as sale
set commission_pct = master.pct
from public.masters as master
where sale.commission_pct is null
  and sale.master = master.name;

do $$
begin
  if exists (select 1 from public.sales where commission_pct is null) then
    raise exception 'Cannot snapshot commission: a sale has no matching master';
  end if;
end $$;

alter table public.sales
  alter column commission_pct set not null,
  add constraint sales_commission_pct_range check (commission_pct between 0 and 100);
