-- Every new sale is a visit of a known client, as decided by the owner on
-- 2026-10-16. The master picks the client (searching by name or the last
-- digits of the number) or creates a card; whether the client is new or
-- returning is then decided from his history instead of a button. A card may
-- have no number — a child, a client who refused — but every such visit is
-- reported to the owner. Masters see numbers masked; the owner sees the card
-- with every visit: when, at what time, to which master.
--
-- The client base existed since July for the old bot and holds 35 cards.
-- Older sales stay without a client; reports that read is_new_client keep
-- working, since a new sale still fills it.

-- ---------------------------------------------------------------- clients
alter table public.clients alter column phone_e164 drop not null;

-- «Был у нас раньше?»: a regular who simply has no card yet. His first
-- recorded visit counts as returning, not new.
alter table public.clients add column if not exists known_before boolean not null default false;

create index if not exists clients_name_search_idx on public.clients (lower(full_name));

-- ------------------------------------------------------------------ sales
alter table public.sales
  add column if not exists client_id uuid references public.clients (id) on delete restrict,
  add column if not exists appointment_id uuid references public.appointments (id) on delete set null,
  -- Snapshots, so every list shows the visit without a lookup and a later
  -- rename does not rewrite who came.
  add column if not exists client_name text,
  add column if not exists client_no_phone boolean not null default false;

create index if not exists sales_client_idx on public.sales (client_id, d desc) where client_id is not null;
-- A booking becomes at most one counted visit.
create unique index if not exists sales_appointment_key
  on public.sales (appointment_id)
  where appointment_id is not null and status is distinct from 'rejected';

-- A visit counts unless the owner rejected it.
create or replace function public.maestro_sale_is_rejected(p_status text, p_comment text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- Never null: a sale with no comment is simply not rejected.
  select btrim(coalesce(p_status, '')) = 'rejected' or coalesce(p_comment, '') = 'owner_approval_rejected'
$$;

create or replace function public.maestro_client_visit_count(p_client_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer from public.sales as sale
  where sale.client_id = p_client_id and not public.maestro_sale_is_rejected(sale.status, sale.comment)
$$;

-- A card made in the salon. A number already in the base is not duplicated:
-- the answer names the existing card so the master can pick it instead.
create or replace function public.maestro_add_client_card(
  p_full_name text,
  p_phone text,
  p_known_before boolean,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  clean_name text := nullif(btrim(coalesce(p_full_name, '')), '');
  phone text;
  existing_id uuid;
  new_id uuid;
begin
  if clean_name is null or char_length(clean_name) > 120 then
    return jsonb_build_object('ok', false, 'error', 'invalid_client_name');
  end if;

  if nullif(btrim(coalesce(p_phone, '')), '') is not null then
    phone := public.maestro_normalize_phone(p_phone);
    if phone is null or phone !~ '^[+][1-9][0-9]{6,14}$' then
      return jsonb_build_object('ok', false, 'error', 'invalid_phone');
    end if;
    select id into existing_id from public.clients where phone_e164 = phone;
    if existing_id is not null then
      return jsonb_build_object('ok', false, 'error', 'client_exists', 'client_id', existing_id);
    end if;
  end if;

  insert into public.clients (
    full_name, phone_e164, known_before, first_source, last_source,
    created_by_user_id, updated_by_user_id
  ) values (
    clean_name, phone, coalesce(p_known_before, false), 'salon', 'salon',
    p_actor_user_id, p_actor_user_id
  ) returning id into new_id;

  insert into public.client_events (client_id, event_type, source, actor_user_id, details)
  values (new_id, 'card_created', 'salon', p_actor_user_id,
    jsonb_build_object('known_before', coalesce(p_known_before, false), 'has_phone', phone is not null));

  return jsonb_build_object('ok', true, 'client_id', new_id);
exception when unique_violation then
  select id into existing_id from public.clients where phone_e164 = phone;
  return jsonb_build_object('ok', false, 'error', 'client_exists', 'client_id', existing_id);
end;
$$;

-- Search by the pieces of a name in any order, or by digits of the number.
-- Most recent visitors first.
create or replace function public.maestro_search_clients(p_query text, p_limit integer default 10)
returns table (
  id uuid,
  full_name text,
  phone_e164 text,
  known_before boolean,
  lifecycle_status text,
  visit_count integer,
  last_visit date,
  last_master text
)
language sql
stable
set search_path = ''
as $$
  with query as (
    select btrim(coalesce(p_query, '')) as text,
      regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g') as digits
  ),
  matched as (
    select client.id, client.full_name, client.phone_e164, client.known_before, client.lifecycle_status
    from public.clients as client, query
    where case
      when query.text ~ '^[0-9 +()-]+$' then
        length(query.digits) >= 2 and client.phone_e164 like '%' || query.digits || '%'
      else
        char_length(query.text) >= 2 and not exists (
          select 1
          from regexp_split_to_table(replace(lower(query.text), 'ё', 'е'), '\s+') as word
          where word <> '' and position(word in replace(lower(client.full_name), 'ё', 'е')) = 0
        )
    end
  )
  select matched.id, matched.full_name, matched.phone_e164, matched.known_before, matched.lifecycle_status,
    coalesce(visits.visit_count, 0), visits.last_visit, visits.last_master
  from matched
  left join lateral (
    select count(*)::integer as visit_count,
      max(sale.d) as last_visit,
      (array_agg(sale.master order by sale.d desc, sale.created_at desc))[1] as last_master
    from public.sales as sale
    where sale.client_id = matched.id and not public.maestro_sale_is_rejected(sale.status, sale.comment)
  ) as visits on true
  order by visits.last_visit desc nulls last, matched.full_name
  limit greatest(1, least(coalesce(p_limit, 10), 20))
$$;

-- Everything the owner sees on a client's card.
create or replace function public.maestro_client_card(p_client_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'client', jsonb_build_object(
      'id', client.id,
      'full_name', client.full_name,
      'phone', client.phone_e164,
      'telegram_user_id', client.telegram_user_id,
      'telegram_username', client.telegram_username,
      'known_before', client.known_before,
      'lifecycle_status', client.lifecycle_status,
      'first_source', client.first_source,
      'created_at', client.created_at
    ),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sale.id,
        'd', sale.d,
        'created_at', sale.created_at,
        'starts_at', appointment.starts_at,
        'master', sale.master,
        'master_id', sale.master_id,
        'amount', coalesce(sale.cash, 0) + coalesce(sale.card, 0) + coalesce(sale.qr, 0),
        'status', btrim(coalesce(sale.status, '')),
        'rejected', public.maestro_sale_is_rejected(sale.status, sale.comment),
        'is_new_client', sale.is_new_client
      ) order by sale.d desc, sale.created_at desc)
      from public.sales as sale
      left join public.appointments as appointment on appointment.id = sale.appointment_id
      where sale.client_id = client.id
    ), '[]'::jsonb),
    'missed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'starts_at', appointment.starts_at,
        'master_id', appointment.master_id,
        'status', appointment.status,
        'reason', appointment.status_reason_code
      ) order by appointment.starts_at desc)
      from public.appointments as appointment
      where appointment.client_id = client.id
        and appointment.status in ('no_show', 'cancelled')
        and coalesce(appointment.status_reason_code, '') <> 'hold_expired'
    ), '[]'::jsonb)
  )
  from public.clients as client
  where client.id = p_client_id
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_sale_is_rejected(text, text)',
    'public.maestro_client_visit_count(uuid)',
    'public.maestro_add_client_card(text, text, boolean, bigint)',
    'public.maestro_search_clients(text, integer)',
    'public.maestro_client_card(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
