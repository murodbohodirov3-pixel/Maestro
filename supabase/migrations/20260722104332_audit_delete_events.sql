create table public.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  entity_type text not null check (btrim(entity_type) <> ''),
  entity_id text not null check (btrim(entity_id) <> ''),
  operation text not null check (operation in ('insert', 'update', 'delete')),
  event_name text not null check (btrim(event_name) <> ''),
  actor_user_id bigint references public.app_users(id) on delete set null,
  actor_name text,
  actor_role text,
  actor_external_id text,
  source text not null check (btrim(source) <> ''),
  correlation_id uuid not null default gen_random_uuid(),
  changed_fields text[] not null default '{}'::text[],
  old_values jsonb,
  new_values jsonb,
  metadata jsonb not null default '{}'::jsonb,
  constraint audit_events_old_values_object check (
    old_values is null or jsonb_typeof(old_values) = 'object'
  ),
  constraint audit_events_new_values_object check (
    new_values is null or jsonb_typeof(new_values) = 'object'
  ),
  constraint audit_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index audit_events_occurred_idx
  on public.audit_events (occurred_at desc, id desc);
create index audit_events_entity_idx
  on public.audit_events (entity_type, entity_id, occurred_at desc, id desc);
create index audit_events_actor_idx
  on public.audit_events (actor_user_id, occurred_at desc, id desc)
  where actor_user_id is not null;
create index audit_events_event_idx
  on public.audit_events (event_name, occurred_at desc, id desc);

alter table public.audit_events enable row level security;

revoke all on table public.audit_events from public, anon, authenticated;
revoke all on sequence public.audit_events_id_seq from public, anon, authenticated;
revoke update, delete, truncate, references, trigger on table public.audit_events from service_role;
grant select, insert on table public.audit_events to service_role;
grant usage, select on sequence public.audit_events_id_seq to service_role;

create or replace function public.maestro_prepare_delete_audit(
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
  select app_user.name, app_user.role
  into actor_record
  from public.app_users app_user
  where app_user.id = p_actor_user_id
    and app_user.active = true;

  if not found then
    raise exception 'invalid_audit_actor';
  end if;

  if actor_record.role not in ('owner', 'admin', 'finance') then
    raise exception 'forbidden';
  end if;

  perform set_config('maestro.audit_actor_user_id', p_actor_user_id::text, true);
  perform set_config('maestro.audit_actor_name', actor_record.name, true);
  perform set_config('maestro.audit_actor_role', actor_record.role, true);
  perform set_config('maestro.audit_source', coalesce(nullif(btrim(p_source), ''), 'web_app'), true);
  perform set_config('maestro.audit_correlation_id', coalesce(p_correlation_id, gen_random_uuid())::text, true);
end;
$$;

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

create trigger audit_fines_delete
after delete on public.fines
for each row execute function public.maestro_capture_delete_audit();

create trigger audit_expenses_delete
after delete on public.expenses
for each row execute function public.maestro_capture_delete_audit();

create trigger audit_debts_delete
after delete on public.debts
for each row execute function public.maestro_capture_delete_audit();

create trigger audit_debt_payments_delete
after delete on public.debt_payments
for each row execute function public.maestro_capture_delete_audit();

create or replace function public.maestro_delete_fine(
  p_id bigint,
  p_actor_user_id bigint,
  p_source text default 'web_app',
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  fine_record public.fines%rowtype;
begin
  perform public.maestro_prepare_delete_audit(
    p_actor_user_id,
    p_source,
    p_correlation_id
  );

  select *
  into fine_record
  from public.fines fine
  where fine.id = p_id
  for update;

  if not found then
    return jsonb_build_object('error', 'fine_not_found');
  end if;

  if fine_record.d < (timezone('Asia/Tashkent', now())::date - 7) then
    return jsonb_build_object('error', 'fine_delete_window_expired');
  end if;

  delete from public.fines where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.maestro_delete_expense(
  p_id bigint,
  p_actor_user_id bigint,
  p_source text default 'web_app',
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.maestro_prepare_delete_audit(
    p_actor_user_id,
    p_source,
    p_correlation_id
  );
  delete from public.expenses where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.maestro_delete_debt_payment(
  p_id bigint,
  p_actor_user_id bigint,
  p_source text default 'web_app',
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.maestro_prepare_delete_audit(
    p_actor_user_id,
    p_source,
    p_correlation_id
  );
  delete from public.debt_payments where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.maestro_delete_debt(
  p_id bigint,
  p_actor_user_id bigint,
  p_source text default 'web_app',
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.maestro_prepare_delete_audit(
    p_actor_user_id,
    p_source,
    p_correlation_id
  );
  delete from public.debts where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.maestro_prepare_delete_audit(bigint, text, uuid)
  from public, anon, authenticated;
revoke execute on function public.maestro_capture_delete_audit()
  from public, anon, authenticated;
revoke execute on function public.maestro_delete_fine(bigint, bigint, text, uuid)
  from public, anon, authenticated;
revoke execute on function public.maestro_delete_expense(bigint, bigint, text, uuid)
  from public, anon, authenticated;
revoke execute on function public.maestro_delete_debt_payment(bigint, bigint, text, uuid)
  from public, anon, authenticated;
revoke execute on function public.maestro_delete_debt(bigint, bigint, text, uuid)
  from public, anon, authenticated;

grant execute on function public.maestro_prepare_delete_audit(bigint, text, uuid)
  to service_role;
grant execute on function public.maestro_delete_fine(bigint, bigint, text, uuid)
  to service_role;
grant execute on function public.maestro_delete_expense(bigint, bigint, text, uuid)
  to service_role;
grant execute on function public.maestro_delete_debt_payment(bigint, bigint, text, uuid)
  to service_role;
grant execute on function public.maestro_delete_debt(bigint, bigint, text, uuid)
  to service_role;
