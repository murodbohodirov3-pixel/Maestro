-- Audit of 2026-11-01, money and rights (owner's «да» of 2026-11-01).

-- №31: the bookkeeper's role is gone; nobody ever had it.
alter table public.app_users drop constraint if exists app_users_role_check;
alter table public.app_users add constraint app_users_role_check
  check (role = any (array['owner', 'admin', 'master', 'partner']));

-- №28: a sign-in lived its 30 days whatever became of the person: a new
-- Telegram, another role, a dismissal. Any such change now ends his sessions,
-- and the next request signs in again through Telegram.
create or replace function public.maestro_end_sessions_on_user_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.app_sessions where user_id = old.id;
  return new;
end;
$$;

drop trigger if exists app_users_end_sessions on public.app_users;
create trigger app_users_end_sessions
  after update of telegram_id, role, master_id, active on public.app_users
  for each row
  when (old.telegram_id is distinct from new.telegram_id
    or old.role is distinct from new.role
    or old.master_id is distinct from new.master_id
    or old.active is distinct from new.active)
  execute function public.maestro_end_sessions_on_user_change();

-- №9: a visit from «Пришёл» and the booking it closes are one write. The
-- booking used to be closed in a second call: if that failed, the visit stood
-- and the booking stayed open, and the master could close it only with a false
-- «Не пришёл». And a deleted visit left its booking closed, which counted as a
-- visit of its own: the client's real first visit, entered again, came out
-- «постоянный». The booking now closes with the visit and opens again when the
-- visit is deleted.
create or replace function public.maestro_sale_closes_booking()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  appointment_record public.appointments;
begin
  select * into appointment_record from public.appointments where id = new.appointment_id for update;
  if not found then raise exception 'appointment_not_found'; end if;
  if appointment_record.status = 'completed' then return new; end if;
  if appointment_record.status not in ('pending', 'confirmed') then raise exception 'appointment_closed'; end if;

  update public.appointments
     set status = 'completed', client_id = coalesce(client_id, new.client_id), hold_expires_at = null,
         updated_at = now()
   where id = new.appointment_id;
  insert into public.appointment_events (appointment_id, event_type, old_values, new_values)
  values (new.appointment_id, 'status_changed', jsonb_build_object('status', appointment_record.status),
    jsonb_build_object('status', 'completed', 'via', 'visit', 'sale_id', new.id));
  return new;
end;
$$;

drop trigger if exists sales_close_booking on public.sales;
create trigger sales_close_booking
  after insert on public.sales
  for each row
  when (new.appointment_id is not null)
  execute function public.maestro_sale_closes_booking();

create or replace function public.maestro_sale_reopens_booking()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.appointments
     set status = 'confirmed', updated_at = now()
   where id = old.appointment_id and status = 'completed';
  if found then
    insert into public.appointment_events (appointment_id, event_type, old_values, new_values)
    values (old.appointment_id, 'status_changed', jsonb_build_object('status', 'completed'),
      jsonb_build_object('status', 'confirmed', 'via', 'visit_deleted', 'sale_id', old.id));
  end if;
  return old;
end;
$$;

drop trigger if exists sales_reopen_booking on public.sales;
create trigger sales_reopen_booking
  after delete on public.sales
  for each row
  when (old.appointment_id is not null)
  execute function public.maestro_sale_reopens_booking();

-- №8: a resend after a lost reply doubled an advance, a payout, an expense
-- or a delivery. Each now carries the id the app gives it, as visits and
-- sales of goods already do, and the second one is absorbed.
alter table public.master_advances add column if not exists client_request_id uuid;
alter table public.master_payouts add column if not exists client_request_id uuid;
alter table public.expenses add column if not exists client_request_id uuid;
alter table public.product_receipts add column if not exists client_request_id uuid;
create unique index if not exists master_advances_client_request_id_key on public.master_advances (client_request_id);
create unique index if not exists master_payouts_client_request_id_key on public.master_payouts (client_request_id);
create unique index if not exists expenses_client_request_id_key on public.expenses (client_request_id);
create unique index if not exists product_receipts_client_request_id_key on public.product_receipts (client_request_id);

-- The delivery, as in 20261014160000_stock.sql, with the id.
drop function if exists public.maestro_add_product_receipt(bigint, text, text, date, integer, bigint, text, numeric, text, bigint);
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
  p_actor_user_id bigint,
  p_client_request_id uuid default null
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
  violated text;
begin
  if p_receipt_date is null or p_qty is null or p_qty < 1 or p_unit_cost is null or p_unit_cost < 1
     or p_paid_by is null or p_paid_by not in ('ishxona', 'murod', 'jamshid', 'opening') then
    return jsonb_build_object('ok', false, 'error', 'invalid_receipt');
  end if;

  if p_client_request_id is not null
     and exists (select 1 from public.product_receipts where client_request_id = p_client_request_id) then
    return jsonb_build_object('ok', true, 'deduplicated', true);
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
    product_id, receipt_date, qty, unit_cost, total_cost, paid_by, expense_id, note, created_by_user_id,
    client_request_id
  ) values (
    product_row.id, p_receipt_date, p_qty, p_unit_cost, p_qty::bigint * p_unit_cost, p_paid_by,
    new_expense_id, clean_note, p_actor_user_id, p_client_request_id
  )
  returning id into new_receipt_id;

  return jsonb_build_object('ok', true, 'id', new_receipt_id, 'product_id', product_row.id, 'expense_id', new_expense_id);
exception
  when check_violation or not_null_violation or numeric_value_out_of_range then
    return jsonb_build_object('ok', false, 'error', 'invalid_receipt');
  when unique_violation then
    get stacked diagnostics violated = constraint_name;
    -- The same delivery sent twice at the same moment.
    if violated = 'product_receipts_client_request_id_key' then
      return jsonb_build_object('ok', true, 'deduplicated', true);
    end if;
    -- Two receipts creating the same new product at the same moment.
    return jsonb_build_object('ok', false, 'error', 'product_name_taken');
end;
$$;

revoke execute on function public.maestro_add_product_receipt(bigint, text, text, date, integer, bigint, text, numeric, text, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.maestro_add_product_receipt(bigint, text, text, date, integer, bigint, text, numeric, text, bigint, uuid)
  to service_role;
revoke execute on function public.maestro_end_sessions_on_user_change() from public, anon, authenticated;
revoke execute on function public.maestro_sale_closes_booking() from public, anon, authenticated;
revoke execute on function public.maestro_sale_reopens_booking() from public, anon, authenticated;
