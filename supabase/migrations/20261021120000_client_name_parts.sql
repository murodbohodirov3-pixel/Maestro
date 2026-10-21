-- A client's first name and surname, each on its own and both required
-- (owner's decision of 2026-10-21). The salon has six clients called Сардор:
-- a master who typed only the name, with the last two digits of the number
-- also alike, recorded the visit on the wrong one. Masters wrote names alone,
-- and so did clients booking on the site.
--
-- full_name stays what every list, visit and booking shows; it is now made
-- from the two parts, «Имя Фамилия». Cards made before are split by a separate
-- data file the owner checked. A card that still has no surname gets one from
-- whoever records the client's next visit or booking: neither is saved
-- without it. A card with both parts is renamed only through the parts.
--
-- The older functions that take one full name stay until the app and the site
-- have moved to the parts; docs/release-2026-10/drop_single_name_functions.sql
-- removes them afterwards.

alter table public.clients
  add column if not exists first_name text,
  add column if not exists last_name text;
alter table public.clients drop constraint if exists clients_name_parts_check;
alter table public.clients add constraint clients_name_parts_check check (
  char_length(coalesce(first_name, '')) <= 40 and char_length(coalesce(last_name, '')) <= 40);

-- A booking from the site carries the two parts until the client confirms it.
alter table public.appointments
  add column if not exists client_first_name text,
  add column if not exists client_last_name text;

-- One part of a name as it is kept: single spaces, no edges, null if empty.
create or replace function public.maestro_name_part(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g')), '')
$$;

-- Two letters at least, no digits (the same rule as _shared/clientName.js).
create or replace function public.maestro_name_part_ok(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(char_length(p_value) between 2 and 40 and p_value !~ '[0-9]', false)
$$;

-- full_name follows the parts whenever a card has them.
create or replace function public.clients_name_from_parts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.first_name := public.maestro_name_part(new.first_name);
  new.last_name := public.maestro_name_part(new.last_name);
  if new.first_name is not null then
    new.full_name := concat_ws(' ', new.first_name, new.last_name);
  end if;
  return new;
end;
$$;

drop trigger if exists clients_name_from_parts on public.clients;
create trigger clients_name_from_parts
  before insert or update on public.clients
  for each row execute function public.clients_name_from_parts();

-- A card's name, once changed, also in the visits and bookings that show it.
create or replace function public.maestro_sync_client_name(p_client_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.sales as sale set client_name = client.full_name
    from public.clients as client
   where client.id = p_client_id and sale.client_id = client.id
     and sale.client_name is distinct from client.full_name;
  update public.appointments as appointment set client_name = client.full_name
    from public.clients as client
   where client.id = p_client_id and appointment.client_id = client.id
     and appointment.client_name is distinct from client.full_name;
$$;

-- A card made in the salon, by its two parts. As before, a number already in
-- the base is not duplicated: the answer names the existing card.
create or replace function public.maestro_add_client_card(
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_known_before boolean,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  first_part text := public.maestro_name_part(p_first_name);
  last_part text := public.maestro_name_part(p_last_name);
  phone text;
  existing_id uuid;
  new_id uuid;
begin
  if not public.maestro_name_part_ok(first_part) then
    return jsonb_build_object('ok', false, 'error', 'invalid_first_name');
  end if;
  if not public.maestro_name_part_ok(last_part) then
    return jsonb_build_object('ok', false, 'error', 'invalid_last_name');
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
    first_name, last_name, full_name, phone_e164, known_before, first_source, last_source,
    created_by_user_id, updated_by_user_id
  ) values (
    first_part, last_part, concat_ws(' ', first_part, last_part), phone,
    coalesce(p_known_before, false), 'salon', 'salon', p_actor_user_id, p_actor_user_id
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

-- The owner corrects a card's two parts and its number. Otherwise as
-- maestro_update_client_card(uuid, text, text, bigint) of 2026-10-17.
create or replace function public.maestro_update_client_card(
  p_client_id uuid,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  card public.clients;
  first_part text := public.maestro_name_part(p_first_name);
  last_part text := public.maestro_name_part(p_last_name);
  phone text;
  other public.clients;
  new_name text;
begin
  select * into card from public.clients where id = p_client_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'client_not_found'); end if;
  if not public.maestro_name_part_ok(first_part) then
    return jsonb_build_object('ok', false, 'error', 'invalid_first_name');
  end if;
  if not public.maestro_name_part_ok(last_part) then
    return jsonb_build_object('ok', false, 'error', 'invalid_last_name');
  end if;
  if nullif(btrim(coalesce(p_phone, '')), '') is not null then
    phone := public.maestro_normalize_phone(p_phone);
    if phone is null or phone !~ '^[+][1-9][0-9]{6,14}$' then
      return jsonb_build_object('ok', false, 'error', 'invalid_phone');
    end if;
    select * into other from public.clients where phone_e164 = phone and id <> p_client_id;
    if found then
      return jsonb_build_object('ok', false, 'error', 'client_exists', 'client_id', other.id, 'full_name', other.full_name);
    end if;
  end if;

  update public.clients
     set first_name = first_part, last_name = last_part, phone_e164 = phone,
         updated_by_user_id = p_actor_user_id, updated_at = now()
   where id = p_client_id
  returning full_name into new_name;
  perform public.maestro_sync_client_name(p_client_id);
  if phone is distinct from card.phone_e164 then
    update public.appointments set client_phone = phone
     where client_id = p_client_id and status in ('pending', 'confirmed');
  end if;

  insert into public.client_events (client_id, event_type, source, actor_user_id, details)
  values (p_client_id, 'card_edited', 'salon', p_actor_user_id, jsonb_build_object(
    'old_name', card.full_name, 'new_name', new_name,
    'old_phone', card.phone_e164, 'new_phone', phone));
  return jsonb_build_object('ok', true, 'client_id', p_client_id);
end;
$$;

-- A card with no surname takes one from whoever records the client's visit or
-- booking. The name it has stays; a card that has both parts is the owner's
-- to change, so here it is left as it is.
create or replace function public.maestro_complete_client_name(
  p_client_id uuid,
  p_last_name text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  card public.clients;
  first_part text;
  last_part text := public.maestro_name_part(p_last_name);
  new_name text;
begin
  select * into card from public.clients where id = p_client_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'client_not_found'); end if;
  if card.last_name is not null then
    return jsonb_build_object('ok', true, 'client_id', p_client_id, 'unchanged', true);
  end if;
  if not public.maestro_name_part_ok(last_part) then
    return jsonb_build_object('ok', false, 'error', 'invalid_last_name');
  end if;
  first_part := coalesce(card.first_name, public.maestro_name_part(card.full_name));
  if not public.maestro_name_part_ok(first_part) then
    return jsonb_build_object('ok', false, 'error', 'invalid_first_name');
  end if;

  update public.clients
     set first_name = first_part, last_name = last_part,
         updated_by_user_id = p_actor_user_id, updated_at = now()
   where id = p_client_id
  returning full_name into new_name;
  perform public.maestro_sync_client_name(p_client_id);

  insert into public.client_events (client_id, event_type, source, actor_user_id, details)
  values (p_client_id, 'card_edited', 'salon', p_actor_user_id, jsonb_build_object(
    'old_name', card.full_name, 'new_name', new_name, 'surname_added', true));
  return jsonb_build_object('ok', true, 'client_id', p_client_id);
end;
$$;

-- Search as before, now with the two parts: the app asks for a surname the
-- card lacks.
drop function if exists public.maestro_search_clients(text, integer);
create function public.maestro_search_clients(p_query text, p_limit integer default 10)
returns table (
  id uuid,
  full_name text,
  first_name text,
  last_name text,
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
    select client.id, client.full_name, client.first_name, client.last_name,
      client.phone_e164, client.known_before, client.lifecycle_status
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
  select matched.id, matched.full_name, matched.first_name, matched.last_name,
    matched.phone_e164, matched.known_before, matched.lifecycle_status,
    public.maestro_client_visit_count(matched.id), visits.last_visit, visits.last_master
  from matched
  left join lateral (
    select max(sale.d) as last_visit,
      (array_agg(sale.master order by sale.d desc, sale.created_at desc))[1] as last_master
    from public.sales as sale
    where sale.client_id = matched.id and not public.maestro_sale_is_rejected(sale.status, sale.comment)
  ) as visits on true
  order by visits.last_visit desc nulls last, matched.full_name
  limit greatest(1, least(coalesce(p_limit, 10), 20))
$$;

-- The owner's card of a client, now with the two parts.
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
      'first_name', client.first_name,
      'last_name', client.last_name,
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

-- The site's hold, as in 20261015120000_online_booking.sql, now taking the
-- name in two parts. p_client_name alone is still taken from a page loaded
-- before the change; such a card is completed at the visit.
drop function if exists public.maestro_hold_booking(text, text[], bigint, timestamptz, text, text, text, text);
create function public.maestro_hold_booking(
  p_token_hash text,
  p_service_ids text[],
  p_master_id bigint,
  p_starts_at timestamptz,
  p_client_name text,
  p_comment text,
  p_lang text,
  p_ip_hash text,
  p_client_first_name text default null,
  p_client_last_name text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  first_part text := public.maestro_name_part(p_client_first_name);
  last_part text := public.maestro_name_part(p_client_last_name);
  clean_name text;
  clean_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  service_record record;
  local_date date;
  today date := (now() at time zone 'Asia/Tashkent')::date;
  horizon integer;
  candidate record;
  appointment_record public.appointments;
  placed boolean := false;
begin
  if first_part is not null or last_part is not null then
    if not public.maestro_name_part_ok(first_part) or not public.maestro_name_part_ok(last_part) then
      return jsonb_build_object('ok', false, 'error', 'invalid_request');
    end if;
    clean_name := concat_ws(' ', first_part, last_part);
  else
    clean_name := nullif(btrim(coalesce(p_client_name, '')), '');
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_starts_at is null
     or coalesce(cardinality(p_service_ids), 0) not between 1 and 10
     or cardinality(p_service_ids) <> (select count(distinct item) from unnest(p_service_ids) as item)
     or clean_name is null or char_length(clean_name) > 81
     or char_length(coalesce(clean_comment, '')) > 300 then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  if p_ip_hash is not null then
    if (select count(*) from public.appointments
        where booking_ip_hash = p_ip_hash and status = 'pending' and source = 'web'
          and hold_expires_at > now()) >= 3
       or not public.maestro_booking_rate_hit(p_ip_hash, 'hold', 10, interval '1 hour') then
      return jsonb_build_object('ok', false, 'error', 'rate_limited');
    end if;
  end if;

  perform public.maestro_expire_booking_holds();

  select count(*)::integer as service_count,
    string_agg(service.name_ru, ' + ' order by requested.position) as service_name,
    sum(service.price_uzs)::bigint as total_price_uzs,
    sum(service.duration_minutes)::integer as total_duration_minutes
  into service_record
  from unnest(p_service_ids) with ordinality as requested (service_id, position)
  join public.booking_services as service on service.id = requested.service_id and service.active;
  if service_record.service_count <> cardinality(p_service_ids) then
    return jsonb_build_object('ok', false, 'error', 'unknown_service');
  end if;
  if service_record.total_duration_minutes not between 5 and 600 then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  local_date := (p_starts_at at time zone 'Asia/Tashkent')::date;
  select booking_horizon_days into horizon from public.settings where id = 1;
  if local_date < today or local_date > today + coalesce(horizon, 31) then
    return jsonb_build_object('ok', false, 'error', 'date_out_of_range');
  end if;

  if p_master_id is not null and not exists (
    select 1 from public.masters as master
    where master.id = p_master_id and master.active and master.show_online
      and (master.online_service_ids is null or p_service_ids <@ master.online_service_ids)
  ) then
    return jsonb_build_object('ok', false, 'error', 'unknown_master');
  end if;

  for candidate in
    select master.id
    from public.masters as master
    where master.active and master.show_online
      and (p_master_id is null or master.id = p_master_id)
      and (master.online_service_ids is null or p_service_ids <@ master.online_service_ids)
      and exists (
        select 1
        from public.maestro_booking_slots(
          service_record.total_duration_minutes, local_date, local_date,
          array[master.id], now() + interval '15 minutes'
        ) as slot
        where slot.slot_start = p_starts_at
      )
    order by (
      select count(*) from public.appointments as booked
      where booked.master_id = master.id
        and booked.status in ('pending', 'confirmed')
        and (booked.starts_at at time zone 'Asia/Tashkent')::date = local_date
    ), random()
  loop
    begin
      insert into public.appointments (
        master_id, service_id, service_ids, service_name, price_uzs, duration_minutes,
        starts_at, ends_at, client_name, client_first_name, client_last_name, notes, status, source,
        hold_expires_at, booking_token_hash, booking_lang, booking_ip_hash
      ) values (
        candidate.id, p_service_ids[1], p_service_ids, service_record.service_name,
        service_record.total_price_uzs, service_record.total_duration_minutes,
        p_starts_at, p_starts_at + make_interval(mins => service_record.total_duration_minutes),
        clean_name, first_part, last_part, clean_comment, 'pending', 'web',
        now() + interval '10 minutes', p_token_hash,
        case when p_lang = 'uz' then 'uz' else 'ru' end, p_ip_hash
      ) returning * into appointment_record;
      placed := true;
      exit;
    exception when exclusion_violation then
      placed := false;
    end;
  end loop;

  if not placed then
    return jsonb_build_object('ok', false, 'error', 'slot_taken');
  end if;

  insert into public.appointment_events (appointment_id, event_type, new_values)
  values (appointment_record.id, 'created', jsonb_build_object(
    'master_id', appointment_record.master_id,
    'service_ids', appointment_record.service_ids,
    'starts_at', appointment_record.starts_at,
    'status', appointment_record.status,
    'source', appointment_record.source,
    'hold_expires_at', appointment_record.hold_expires_at
  ));

  return jsonb_build_object('ok', true, 'booking', public.maestro_booking_view(appointment_record));
end;
$$;

-- The confirmation, as in 20261019100000_staff_site_bookings.sql. New here:
-- the two parts typed on the site make a new card's name, and give a card
-- found by the number the surname it lacked when its first name is the same.
-- Nothing else of an existing card is renamed by a booking (2026-10-17).
create or replace function public.maestro_confirm_booking(
  p_appointment_id uuid,
  p_tg_user_id text,
  p_phone text,
  p_tg_username text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  appointment_record public.appointments;
  phone text;
  resolved_client_id uuid;
  existing_client_id uuid;
  client_status text;
  master_record record;
  named integer := 0;
begin
  select * into appointment_record from public.appointments where id = p_appointment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if appointment_record.booking_tg_user_id is distinct from p_tg_user_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if appointment_record.status = 'confirmed' then
    return jsonb_build_object('ok', true, 'already_confirmed', true,
      'booking', public.maestro_booking_view(appointment_record));
  end if;
  if appointment_record.status <> 'pending' or appointment_record.hold_expires_at <= now() then
    perform public.maestro_expire_booking_holds();
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  -- A staff account: the time goes back to the site now, not in ten minutes.
  if exists (select 1 from public.app_users where active and telegram_id::text = p_tg_user_id) then
    update public.appointments set hold_expires_at = now(), updated_at = now()
     where id = appointment_record.id;
    perform public.maestro_expire_booking_holds();
    return jsonb_build_object('ok', false, 'error', 'staff_account',
      'lang', coalesce(appointment_record.booking_lang, 'ru'));
  end if;

  phone := coalesce(
    public.maestro_normalize_phone(p_phone),
    (select phone_e164 from public.clients where telegram_user_id = p_tg_user_id)
  );
  if phone is null then return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;

  select id, lifecycle_status into existing_client_id, client_status from public.clients where phone_e164 = phone;
  if client_status = 'blocked' then
    update public.appointments
       set status = 'cancelled', cancelled_by = 'salon', status_reason_code = 'salon_other',
           status_reason_note = 'Клиент заблокирован', cancelled_at = now(), updated_at = now()
     where id = appointment_record.id;
    return jsonb_build_object('ok', false, 'error', 'client_blocked');
  end if;

  -- The Telegram account now belongs to this number; an older card that
  -- carried it under another number lets go of it.
  update public.clients set telegram_user_id = null, updated_at = now()
   where telegram_user_id = p_tg_user_id and phone_e164 <> phone;

  resolved_client_id := public.maestro_upsert_client(
    appointment_record.client_name, phone, 'web', p_tg_user_id, p_tg_username,
    coalesce(appointment_record.booking_lang, 'unknown'), null
  );
  if resolved_client_id is null then return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;

  if appointment_record.client_first_name is not null and appointment_record.client_last_name is not null then
    update public.clients as client
       set first_name = appointment_record.client_first_name,
           last_name = appointment_record.client_last_name,
           updated_at = now()
     where client.id = resolved_client_id
       and (existing_client_id is null or (
         client.last_name is null
         and lower(coalesce(client.first_name, client.full_name)) = lower(appointment_record.client_first_name)));
    get diagnostics named = row_count;
  end if;

  update public.appointments
     set status = 'confirmed', client_id = resolved_client_id, client_phone = phone,
         hold_expires_at = null, updated_at = now()
   where id = appointment_record.id
  returning * into appointment_record;
  -- A card that has just got its surname shows it everywhere, this booking too.
  if named > 0 and existing_client_id is not null then
    perform public.maestro_sync_client_name(resolved_client_id);
    select * into appointment_record from public.appointments where id = appointment_record.id;
  end if;

  insert into public.appointment_events (appointment_id, event_type, old_values, new_values)
  values (appointment_record.id, 'status_changed', jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'confirmed', 'client_id', resolved_client_id));
  insert into public.client_events (client_id, event_type, source, appointment_id, details)
  values (resolved_client_id, 'appointment_created', 'web', appointment_record.id,
    jsonb_build_object('status', 'confirmed'));

  select master.name,
    coalesce(
      (select app_user.telegram_id::text from public.app_users as app_user
        where app_user.master_id = master.id and app_user.active and app_user.telegram_id is not null
        limit 1),
      master.telegram_id::text
    ) as chat_id
  into master_record
  from public.masters as master where master.id = appointment_record.master_id;

  return jsonb_build_object(
    'ok', true,
    'already_confirmed', false,
    'appointment_id', appointment_record.id,
    'booking', public.maestro_booking_view(appointment_record),
    'master_name', master_record.name,
    'master_chat_id', master_record.chat_id,
    'service_name', appointment_record.service_name,
    'client_name', appointment_record.client_name,
    'client_phone', phone,
    'comment', appointment_record.notes,
    'lang', coalesce(appointment_record.booking_lang, 'ru')
  );
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_name_part(text)',
    'public.maestro_name_part_ok(text)',
    'public.clients_name_from_parts()',
    'public.maestro_sync_client_name(uuid)',
    'public.maestro_add_client_card(text, text, text, boolean, bigint)',
    'public.maestro_update_client_card(uuid, text, text, text, bigint)',
    'public.maestro_complete_client_name(uuid, text, bigint)',
    'public.maestro_search_clients(text, integer)',
    'public.maestro_client_card(uuid)',
    'public.maestro_hold_booking(text, text[], bigint, timestamptz, text, text, text, text, text, text)',
    'public.maestro_confirm_booking(uuid, text, text, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
