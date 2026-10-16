-- Client cards the owner corrects (owner's request of 2026-10-17): masters
-- will mistype names and numbers for a while, so the owner fixes a card's
-- name and number himself, and when the right number already belongs to
-- another card, merges the two into one.
--
-- And a booking from the site no longer renames a card. A web booking found
-- an existing card by its number and wrote the name typed on the site over
-- the card's own: the owner's test «Мурод» renamed the July client Oybek.

-- maestro_upsert_client as before, except that a web booking keeps the name an
-- existing card already has.
create or replace function public.maestro_upsert_client(
  p_full_name text,
  p_phone text,
  p_source text,
  p_telegram_user_id text default null,
  p_telegram_username text default null,
  p_language text default 'unknown',
  p_actor_user_id bigint default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  normalized_phone text;
  client_id uuid;
begin
  normalized_phone := public.maestro_normalize_phone(p_phone);
  if normalized_phone is null or nullif(btrim(p_full_name), '') is null then
    return null;
  end if;

  insert into public.clients (
    full_name, phone_e164, telegram_user_id, telegram_username, preferred_language,
    first_source, last_source, created_by_user_id, updated_by_user_id
  ) values (
    btrim(p_full_name), normalized_phone, nullif(btrim(p_telegram_user_id), ''),
    nullif(btrim(p_telegram_username), ''),
    case when p_language in ('ru', 'uz') then p_language else 'unknown' end,
    coalesce(nullif(btrim(p_source), ''), 'unknown'),
    coalesce(nullif(btrim(p_source), ''), 'unknown'),
    p_actor_user_id, p_actor_user_id
  )
  on conflict (phone_e164) do update set
    full_name = case when excluded.last_source = 'web' then public.clients.full_name else excluded.full_name end,
    telegram_user_id = coalesce(excluded.telegram_user_id, public.clients.telegram_user_id),
    telegram_username = coalesce(excluded.telegram_username, public.clients.telegram_username),
    preferred_language = case when excluded.preferred_language = 'unknown'
      then public.clients.preferred_language else excluded.preferred_language end,
    last_source = excluded.last_source,
    last_contact_at = now(),
    updated_by_user_id = excluded.updated_by_user_id,
    updated_at = now()
  returning id into client_id;

  insert into public.client_events (client_id, event_type, source, actor_user_id)
  values (client_id, 'contact_captured', coalesce(nullif(btrim(p_source), ''), 'unknown'), p_actor_user_id);

  return client_id;
end;
$$;

-- A card's name and number, as the owner corrects them. The new name is also
-- written into the visits and bookings that show it; the number into bookings
-- still open. A number another card already has is refused with that card,
-- so the owner can merge the two.
create or replace function public.maestro_update_client_card(
  p_client_id uuid,
  p_full_name text,
  p_phone text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  card public.clients;
  clean_name text := nullif(btrim(coalesce(p_full_name, '')), '');
  phone text;
  other public.clients;
begin
  select * into card from public.clients where id = p_client_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'client_not_found'); end if;
  if clean_name is null or char_length(clean_name) > 120 then
    return jsonb_build_object('ok', false, 'error', 'invalid_client_name');
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
     set full_name = clean_name, phone_e164 = phone, updated_by_user_id = p_actor_user_id, updated_at = now()
   where id = p_client_id;
  if clean_name is distinct from card.full_name then
    update public.sales set client_name = clean_name where client_id = p_client_id;
    update public.appointments set client_name = clean_name where client_id = p_client_id;
  end if;
  if phone is distinct from card.phone_e164 then
    update public.appointments set client_phone = phone
     where client_id = p_client_id and status in ('pending', 'confirmed');
  end if;

  insert into public.client_events (client_id, event_type, source, actor_user_id, details)
  values (p_client_id, 'card_edited', 'salon', p_actor_user_id, jsonb_build_object(
    'old_name', card.full_name, 'new_name', clean_name,
    'old_phone', card.phone_e164, 'new_phone', phone));
  return jsonb_build_object('ok', true, 'client_id', p_client_id);
end;
$$;

-- Two cards of one person become one: every visit, booking and event of the
-- first moves to the second, which keeps its own name and number, takes the
-- first's Telegram if it has none, and the first card is removed.
create or replace function public.maestro_merge_clients(
  p_from uuid,
  p_into uuid,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  source_card public.clients;
  target_card public.clients;
  moved_sales integer;
  moved_appointments integer;
begin
  if p_from is null or p_into is null or p_from = p_into then
    return jsonb_build_object('ok', false, 'error', 'invalid_merge');
  end if;
  select * into source_card from public.clients where id = p_from for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'client_not_found'); end if;
  select * into target_card from public.clients where id = p_into for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'client_not_found'); end if;

  update public.sales set client_id = p_into, client_name = target_card.full_name where client_id = p_from;
  get diagnostics moved_sales = row_count;
  update public.appointments
     set client_id = p_into, client_name = target_card.full_name,
         client_phone = case when status in ('pending', 'confirmed') then coalesce(target_card.phone_e164, client_phone) else client_phone end
   where client_id = p_from;
  get diagnostics moved_appointments = row_count;
  update public.client_events set client_id = p_into where client_id = p_from;
  update public.client_consent_events set client_id = p_into where client_id = p_from;

  -- The card that stays takes what only the other had.
  update public.clients set telegram_user_id = null, telegram_username = null where id = p_from;
  update public.clients
     set telegram_user_id = coalesce(target_card.telegram_user_id, source_card.telegram_user_id),
         telegram_username = case when target_card.telegram_user_id is null then source_card.telegram_username else target_card.telegram_username end,
         known_before = target_card.known_before or source_card.known_before,
         visit_count = coalesce(target_card.visit_count, 0) + coalesce(source_card.visit_count, 0),
         first_contact_at = least(target_card.first_contact_at, source_card.first_contact_at),
         notes = nullif(concat_ws(E'\n', target_card.notes, source_card.notes), ''),
         updated_by_user_id = p_actor_user_id,
         updated_at = now()
   where id = p_into;

  delete from public.clients where id = p_from;

  insert into public.client_events (client_id, event_type, source, actor_user_id, details)
  values (p_into, 'cards_merged', 'salon', p_actor_user_id, jsonb_build_object(
    'from_id', p_from, 'from_name', source_card.full_name, 'from_phone', source_card.phone_e164,
    'sales', moved_sales, 'appointments', moved_appointments));
  return jsonb_build_object('ok', true, 'client_id', p_into, 'sales', moved_sales, 'appointments', moved_appointments);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_upsert_client(text, text, text, text, text, text, bigint)',
    'public.maestro_update_client_card(uuid, text, text, bigint)',
    'public.maestro_merge_clients(uuid, uuid, bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
