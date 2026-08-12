-- Two gaps this closes:
--   1. A retried or double-tapped addSale created a second identical sale. The
--      client now sends a request id that survives its own retries, and this
--      index makes the duplicate impossible rather than merely unlikely.
--   2. sales and attendance were the only operational tables whose deletions
--      left no trace, while fines, expenses and debts were already journalled.

alter table public.sales
  add column if not exists client_request_id uuid;

create unique index if not exists sales_client_request_id_key
  on public.sales (client_request_id)
  where client_request_id is not null;

-- A master deleting his own pending sale is a legitimate actor, but
-- maestro_prepare_delete_audit deliberately rejects non-admin roles. Deletions
-- still have to be attributed, so this sibling accepts any active user and is
-- used only to stamp the actor, never to authorize anything.
create or replace function public.maestro_set_audit_actor(
  p_actor_user_id bigint,
  p_source text,
  p_correlation_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_record record;
begin
  select app_user.id, app_user.name, app_user.role
  into actor_record
  from public.app_users app_user
  where app_user.id = p_actor_user_id
    and app_user.active = true;

  if not found then
    raise exception 'invalid_audit_actor';
  end if;

  perform set_config('maestro.audit_actor_user_id', p_actor_user_id::text, true);
  perform set_config('maestro.audit_actor_name', actor_record.name, true);
  perform set_config('maestro.audit_actor_role', actor_record.role, true);
  perform set_config('maestro.audit_source', coalesce(nullif(btrim(p_source), ''), 'web_app'), true);
  perform set_config('maestro.audit_correlation_id', coalesce(p_correlation_id, gen_random_uuid())::text, true);
end;
$$;

revoke all on function public.maestro_set_audit_actor(bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.maestro_set_audit_actor(bigint, text, uuid) to service_role;

-- Same body as before; only the entity_type mapping gains the two new tables,
-- so an unmapped table would otherwise be journalled under its raw plural name.
create or replace function public.maestro_capture_delete_audit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_user_id_text text := current_setting('maestro.audit_actor_user_id', true);
  correlation_id_text text := current_setting('maestro.audit_correlation_id', true);
  audit_entity_type text;
begin
  audit_entity_type := case tg_table_name
    when 'fines' then 'fine'
    when 'expenses' then 'expense'
    when 'debts' then 'debt'
    when 'debt_payments' then 'debt_payment'
    when 'sales' then 'sale'
    when 'attendance' then 'attendance'
    else tg_table_name
  end;

  insert into public.audit_events (
    entity_type,
    entity_id,
    operation,
    event_name,
    actor_user_id,
    actor_name,
    actor_role,
    source,
    correlation_id,
    changed_fields,
    old_values,
    new_values,
    metadata
  ) values (
    audit_entity_type,
    to_jsonb(old) ->> 'id',
    'delete',
    audit_entity_type || '.deleted',
    nullif(actor_user_id_text, '')::bigint,
    nullif(current_setting('maestro.audit_actor_name', true), ''),
    nullif(current_setting('maestro.audit_actor_role', true), ''),
    coalesce(nullif(current_setting('maestro.audit_source', true), ''), 'database'),
    coalesce(nullif(correlation_id_text, '')::uuid, gen_random_uuid()),
    '{}'::text[],
    to_jsonb(old),
    null,
    '{}'::jsonb
  );

  return old;
end;
$$;

drop trigger if exists audit_sales_delete on public.sales;
create trigger audit_sales_delete
after delete on public.sales
for each row execute function public.maestro_capture_delete_audit();

drop trigger if exists audit_attendance_delete on public.attendance;
create trigger audit_attendance_delete
after delete on public.attendance
for each row execute function public.maestro_capture_delete_audit();
