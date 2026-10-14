-- Склад: the goods the salon resells (shampoos, waxes, drinks). Until now a
-- purchase was an expense and a sale was nowhere, so the margin on goods was
-- earned but never counted. The owner's decisions of 2026-10-14:
--
-- * A receipt records quantity and the price paid per unit. It also becomes an
--   expense at once, in the section of whoever paid (salon, Мурод or Жамшид),
--   so the cash picture stays as it was. Goods already on the shelf when the
--   stock starts are entered as 'opening' and create no expense.
-- * Only the administrator enters sales, and each waits for the owner. The
--   amount is what the salon kept, after the seller's share; who sold and how
--   much he got is not recorded. An owner's own entry is approved at once.
--   The payment method is kept, so the owner can tell what cash the till owes
--   him for goods next to what it owes for haircuts.
-- * The margin is that amount less the average purchase price of the units sold,
--   fixed on the sale when it is entered, the way a sale keeps its commission.
--
-- Stock = received − sold (pending or approved) − written off. A pending sale
-- already holds its units, so one bottle cannot be sold twice while the owner
-- is still deciding; a rejected one gives them back.
--
-- Every write goes through the functions below, called by the api with the
-- service role. Each takes a per-product lock, so two entries cannot both pass
-- the stock check for the last unit.

create table if not exists public.products (
  id bigint generated always as identity primary key,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  category text not null default 'care' check (category in ('care', 'drinks', 'other')),
  active boolean not null default true,
  created_by_user_id bigint references public.app_users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists products_name_key on public.products (lower(btrim(name)));

create table if not exists public.product_receipts (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products (id) on delete restrict,
  receipt_date date not null,
  qty integer not null check (qty between 1 and 100000),
  unit_cost bigint not null check (unit_cost between 1 and 100000000),
  total_cost bigint not null check (total_cost >= 1),
  paid_by text not null check (paid_by in ('ishxona', 'murod', 'jamshid', 'opening')),
  -- The expense this receipt created. Restrict: deleting it from Расходы
  -- alone would leave the goods on the shelf and the money unspent.
  expense_id bigint references public.expenses (id) on delete restrict,
  note text check (note is null or char_length(note) <= 300),
  created_by_user_id bigint references public.app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((paid_by = 'opening') = (expense_id is null))
);
create index if not exists product_receipts_product_idx on public.product_receipts (product_id);
create unique index if not exists product_receipts_expense_key on public.product_receipts (expense_id) where expense_id is not null;

create table if not exists public.product_sales (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products (id) on delete restrict,
  sale_date date not null,
  qty integer not null check (qty between 1 and 1000),
  -- What the salon kept, after the seller's share.
  amount bigint not null check (amount between 1 and 100000000),
  -- Average purchase price per unit when the sale was entered.
  unit_cost numeric(14, 2) not null check (unit_cost >= 0),
  payment_method text not null check (payment_method in ('cash', 'card', 'qr')),
  status text not null check (status in ('pending', 'approved', 'rejected')),
  decided_by_user_id bigint references public.app_users (id) on delete set null,
  decided_at timestamptz,
  client_request_id uuid unique,
  created_by_user_id bigint references public.app_users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists product_sales_product_idx on public.product_sales (product_id);

create table if not exists public.product_writeoffs (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products (id) on delete restrict,
  writeoff_date date not null,
  qty integer not null check (qty between 1 and 100000),
  -- used: went into the work; gift: given to a client; damaged; recount: the
  -- shelf held fewer than the app thought.
  reason text not null check (reason in ('used', 'gift', 'damaged', 'recount')),
  note text check (note is null or char_length(note) <= 300),
  created_by_user_id bigint references public.app_users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists product_writeoffs_product_idx on public.product_writeoffs (product_id);

-- Same stance as every Maestro table: only server-side code reads it.
alter table public.products enable row level security;
alter table public.product_receipts enable row level security;
alter table public.product_sales enable row level security;
alter table public.product_writeoffs enable row level security;
revoke all on public.products, public.product_receipts, public.product_sales, public.product_writeoffs from anon, authenticated;

-- Deletions land in the owner's deletion log like every other record.
drop trigger if exists audit_product_receipts_delete on public.product_receipts;
create trigger audit_product_receipts_delete after delete on public.product_receipts
  for each row execute function public.maestro_capture_delete_audit();
drop trigger if exists audit_product_sales_delete on public.product_sales;
create trigger audit_product_sales_delete after delete on public.product_sales
  for each row execute function public.maestro_capture_delete_audit();
drop trigger if exists audit_product_writeoffs_delete on public.product_writeoffs;
create trigger audit_product_writeoffs_delete after delete on public.product_writeoffs
  for each row execute function public.maestro_capture_delete_audit();

create or replace function public.maestro_product_stock(p_product_id bigint)
returns integer
language sql
stable
set search_path = ''
as $$
  select (
    coalesce((select sum(r.qty) from public.product_receipts r where r.product_id = p_product_id), 0)
    - coalesce((select sum(s.qty) from public.product_sales s where s.product_id = p_product_id and s.status in ('pending', 'approved')), 0)
    - coalesce((select sum(w.qty) from public.product_writeoffs w where w.product_id = p_product_id), 0)
  )::integer
$$;

-- The average price paid per unit over every receipt so far.
create or replace function public.maestro_product_unit_cost(p_product_id bigint)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(round(sum(r.total_cost)::numeric / nullif(sum(r.qty), 0), 2), 0)
  from public.product_receipts r
  where r.product_id = p_product_id
$$;

create or replace function public.maestro_lock_product(p_product_id bigint)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('product_stock:' || p_product_id::text, 0))
$$;

-- A receipt for an existing product (p_product_id) or for a new one named
-- p_product_name. Creates the matching expense unless the goods were already
-- on the shelf ('opening').
create or replace function public.maestro_add_product_receipt(
  p_product_id bigint,
  p_product_name text,
  p_category text,
  p_receipt_date date,
  p_qty integer,
  p_unit_cost bigint,
  p_paid_by text,
  p_usd_rate numeric,
  p_note text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  product_row public.products%rowtype;
  clean_name text := nullif(btrim(coalesce(p_product_name, '')), '');
  clean_note text := nullif(btrim(coalesce(p_note, '')), '');
  new_expense_id bigint;
  new_receipt_id bigint;
begin
  if p_receipt_date is null or p_qty is null or p_qty < 1 or p_unit_cost is null or p_unit_cost < 1
     or p_paid_by is null or p_paid_by not in ('ishxona', 'murod', 'jamshid', 'opening') then
    return jsonb_build_object('ok', false, 'error', 'invalid_receipt');
  end if;

  if p_product_id is not null then
    select * into product_row from public.products where id = p_product_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'product_not_found');
    end if;
  elsif clean_name is not null then
    select * into product_row from public.products where lower(btrim(name)) = lower(clean_name);
    if not found then
      insert into public.products (name, category, created_by_user_id)
      values (clean_name, coalesce(nullif(p_category, ''), 'care'), p_actor_user_id)
      returning * into product_row;
    end if;
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_receipt');
  end if;

  perform public.maestro_lock_product(product_row.id);

  -- Restocking a product that was hidden from the list brings it back.
  if not product_row.active then
    update public.products set active = true where id = product_row.id;
  end if;

  if p_paid_by <> 'opening' then
    insert into public.expenses (date, section, category, name, qty, amount_uzs, usd_rate, note)
    values (
      p_receipt_date,
      p_paid_by,
      'stock',
      'Склад: ' || product_row.name,
      p_qty::text,
      p_qty::bigint * p_unit_cost,
      p_usd_rate,
      clean_note
    )
    returning id into new_expense_id;
  end if;

  insert into public.product_receipts (
    product_id, receipt_date, qty, unit_cost, total_cost, paid_by, expense_id, note, created_by_user_id
  ) values (
    product_row.id, p_receipt_date, p_qty, p_unit_cost, p_qty::bigint * p_unit_cost, p_paid_by,
    new_expense_id, clean_note, p_actor_user_id
  )
  returning id into new_receipt_id;

  return jsonb_build_object('ok', true, 'id', new_receipt_id, 'product_id', product_row.id, 'expense_id', new_expense_id);
exception
  when check_violation or not_null_violation or numeric_value_out_of_range then
    return jsonb_build_object('ok', false, 'error', 'invalid_receipt');
  -- Two receipts creating the same new product at the same moment.
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'product_name_taken');
end;
$$;

create or replace function public.maestro_add_product_sale(
  p_product_id bigint,
  p_sale_date date,
  p_qty integer,
  p_amount bigint,
  p_payment_method text,
  p_approved boolean,
  p_actor_user_id bigint,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  in_stock integer;
  new_id bigint;
begin
  if p_product_id is null or p_sale_date is null or p_qty is null or p_qty < 1
     or p_amount is null or p_amount < 1
     or p_payment_method is null or p_payment_method not in ('cash', 'card', 'qr') then
    return jsonb_build_object('ok', false, 'error', 'invalid_product_sale');
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    return jsonb_build_object('ok', false, 'error', 'product_not_found');
  end if;

  perform public.maestro_lock_product(p_product_id);

  -- A resend of a sale that already landed is absorbed, not doubled.
  if p_client_request_id is not null
     and exists (select 1 from public.product_sales where client_request_id = p_client_request_id) then
    return jsonb_build_object('ok', true, 'deduplicated', true);
  end if;

  in_stock := public.maestro_product_stock(p_product_id);
  if in_stock < p_qty then
    return jsonb_build_object('ok', false, 'error', 'not_enough_stock', 'stock', in_stock);
  end if;

  insert into public.product_sales (
    product_id, sale_date, qty, amount, unit_cost, payment_method, status,
    decided_by_user_id, decided_at, client_request_id, created_by_user_id
  ) values (
    p_product_id, p_sale_date, p_qty, p_amount, public.maestro_product_unit_cost(p_product_id), p_payment_method,
    case when p_approved then 'approved' else 'pending' end,
    case when p_approved then p_actor_user_id end,
    case when p_approved then now() end,
    p_client_request_id, p_actor_user_id
  )
  returning id into new_id;

  return jsonb_build_object('ok', true, 'id', new_id);
exception
  when unique_violation then
    return jsonb_build_object('ok', true, 'deduplicated', true);
  when check_violation or not_null_violation or numeric_value_out_of_range then
    return jsonb_build_object('ok', false, 'error', 'invalid_product_sale');
end;
$$;

-- The owner's decision on a sale. Reversible, like a master's sale; turning a
-- rejected sale back into an approved one takes its units again, so it needs
-- them to be there.
create or replace function public.maestro_set_product_sale_status(
  p_id bigint,
  p_status text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  sale_row public.product_sales%rowtype;
begin
  if p_status is null or p_status not in ('approved', 'rejected') then
    return jsonb_build_object('ok', false, 'error', 'invalid_product_sale_status');
  end if;

  select * into sale_row from public.product_sales where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'product_sale_not_found');
  end if;

  perform public.maestro_lock_product(sale_row.product_id);
  select * into sale_row from public.product_sales where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'product_sale_not_found');
  end if;

  if p_status = 'approved' and sale_row.status = 'rejected'
     and public.maestro_product_stock(sale_row.product_id) < sale_row.qty then
    return jsonb_build_object('ok', false, 'error', 'not_enough_stock');
  end if;

  update public.product_sales
     set status = p_status,
         decided_by_user_id = p_actor_user_id,
         decided_at = now()
   where id = p_id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.maestro_add_product_writeoff(
  p_product_id bigint,
  p_writeoff_date date,
  p_qty integer,
  p_reason text,
  p_note text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  in_stock integer;
  new_id bigint;
begin
  if p_product_id is null or p_writeoff_date is null or p_qty is null or p_qty < 1
     or p_reason is null or p_reason not in ('used', 'gift', 'damaged', 'recount') then
    return jsonb_build_object('ok', false, 'error', 'invalid_writeoff');
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    return jsonb_build_object('ok', false, 'error', 'product_not_found');
  end if;

  perform public.maestro_lock_product(p_product_id);
  in_stock := public.maestro_product_stock(p_product_id);
  if in_stock < p_qty then
    return jsonb_build_object('ok', false, 'error', 'not_enough_stock', 'stock', in_stock);
  end if;

  insert into public.product_writeoffs (product_id, writeoff_date, qty, reason, note, created_by_user_id)
  values (p_product_id, p_writeoff_date, p_qty, p_reason, nullif(btrim(coalesce(p_note, '')), ''), p_actor_user_id)
  returning id into new_id;

  return jsonb_build_object('ok', true, 'id', new_id);
exception
  when check_violation or not_null_violation then
    return jsonb_build_object('ok', false, 'error', 'invalid_writeoff');
end;
$$;

-- Deletes a receipt, a sale or a write-off, audited. The api decides who may
-- ask: p_any_recent lets the owner remove any entry dated within the last two
-- days; without it only the actor's own pending sale may go. A receipt takes
-- its expense with it, and cannot go if its units have already been sold.
create or replace function public.maestro_delete_stock_entry(
  p_kind text,
  p_id bigint,
  p_actor_user_id bigint,
  p_any_recent boolean,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  today date := (now() at time zone 'Asia/Tashkent')::date;
  receipt_row public.product_receipts%rowtype;
  sale_row public.product_sales%rowtype;
  writeoff_row public.product_writeoffs%rowtype;
begin
  if p_kind = 'receipt' then
    select * into receipt_row from public.product_receipts where id = p_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'stock_entry_not_found'); end if;
    if not p_any_recent then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
    if receipt_row.receipt_date < today - 2 then
      return jsonb_build_object('ok', false, 'error', 'stock_entry_delete_window_expired');
    end if;
    perform public.maestro_lock_product(receipt_row.product_id);
    if public.maestro_product_stock(receipt_row.product_id) < receipt_row.qty then
      return jsonb_build_object('ok', false, 'error', 'receipt_already_sold');
    end if;
    perform public.maestro_prepare_delete_audit(p_actor_user_id, 'web_app', p_correlation_id);
    delete from public.product_receipts where id = p_id;
    if receipt_row.expense_id is not null then
      delete from public.expenses where id = receipt_row.expense_id;
    end if;
    return jsonb_build_object('ok', true);
  end if;

  if p_kind = 'sale' then
    select * into sale_row from public.product_sales where id = p_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'stock_entry_not_found'); end if;
    if p_any_recent then
      if sale_row.sale_date < today - 2 then
        return jsonb_build_object('ok', false, 'error', 'stock_entry_delete_window_expired');
      end if;
    elsif sale_row.status <> 'pending' or sale_row.created_by_user_id is distinct from p_actor_user_id then
      return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;
    perform public.maestro_prepare_delete_audit(p_actor_user_id, 'web_app', p_correlation_id);
    delete from public.product_sales where id = p_id;
    return jsonb_build_object('ok', true);
  end if;

  if p_kind = 'writeoff' then
    select * into writeoff_row from public.product_writeoffs where id = p_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'stock_entry_not_found'); end if;
    if not p_any_recent then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
    if writeoff_row.writeoff_date < today - 2 then
      return jsonb_build_object('ok', false, 'error', 'stock_entry_delete_window_expired');
    end if;
    perform public.maestro_prepare_delete_audit(p_actor_user_id, 'web_app', p_correlation_id);
    delete from public.product_writeoffs where id = p_id;
    return jsonb_build_object('ok', true);
  end if;

  return jsonb_build_object('ok', false, 'error', 'invalid_stock_entry');
end;
$$;

-- Hides a product from the lists once nothing of it is left; a new receipt
-- brings it back. Its history stays.
create or replace function public.maestro_set_product_active(
  p_product_id bigint,
  p_active boolean
)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  if p_product_id is null or p_active is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_product');
  end if;
  perform public.maestro_lock_product(p_product_id);
  if not p_active and public.maestro_product_stock(p_product_id) > 0 then
    return jsonb_build_object('ok', false, 'error', 'product_still_in_stock');
  end if;
  update public.products set active = p_active where id = p_product_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'product_not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_product_stock(bigint)',
    'public.maestro_product_unit_cost(bigint)',
    'public.maestro_lock_product(bigint)',
    'public.maestro_add_product_receipt(bigint, text, text, date, integer, bigint, text, numeric, text, bigint)',
    'public.maestro_add_product_sale(bigint, date, integer, bigint, text, boolean, bigint, uuid)',
    'public.maestro_set_product_sale_status(bigint, text, bigint)',
    'public.maestro_add_product_writeoff(bigint, date, integer, text, text, bigint)',
    'public.maestro_delete_stock_entry(text, bigint, bigint, boolean, uuid)',
    'public.maestro_set_product_active(bigint, boolean)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
