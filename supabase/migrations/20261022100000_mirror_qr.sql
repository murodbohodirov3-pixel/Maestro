-- A QR code at every master's mirror (owner's decisions of 2026-10-21). The
-- client in the chair scans it and @MaestroBarberia_bot asks him for his
-- language, his number (one button), and, when the number is new, his name,
-- his surname and whether he has been to Maestro before; a card without a
-- surname is asked only for that. The bot never offers the name of his
-- Telegram profile: it is a nickname nine times out of ten. The master then
-- finds him at the top of the visit form, «Отсканировал у вашего зеркала», for
-- two hours or until a visit of that client is recorded, whichever comes
-- first, so the master types neither the name nor the number. Staff accounts
-- are refused, as on the site.

-- ------------------------------------------------------------- the codes
-- The code in the link of a master's QR: t.me/MaestroBarberia_bot?start=m_<code>.
-- Ten random characters rather than the master's id, so a code can be
-- replaced without the others changing.
alter table public.masters
  add column if not exists mirror_code text default substr(md5(gen_random_uuid()::text), 1, 10);
update public.masters set mirror_code = substr(md5(gen_random_uuid()::text), 1, 10) where mirror_code is null;
alter table public.masters drop constraint if exists masters_mirror_code_key;
alter table public.masters add constraint masters_mirror_code_key unique (mirror_code);

-- ---------------------------------------------------------- the scans
-- A client who scanned a master's QR. Shown to that master while it is fresh
-- and unused; recording a visit of the client uses it (the api).
create table if not exists public.client_scans (
  id bigint generated always as identity primary key,
  client_id uuid not null references public.clients (id) on delete cascade,
  master_id bigint not null references public.masters (id) on delete cascade,
  scanned_at timestamptz not null default now(),
  used_at timestamptz
);
create index if not exists client_scans_fresh_idx
  on public.client_scans (master_id, scanned_at desc) where used_at is null;
create index if not exists client_scans_client_idx
  on public.client_scans (client_id) where used_at is null;
alter table public.client_scans enable row level security;
revoke all on table public.client_scans from public, anon, authenticated;

-- ------------------------------------------------- the talk with the bot
-- Where one Telegram user is in the bot's questions. Twenty minutes without
-- an answer and he scans again.
create table if not exists public.mirror_sessions (
  tg_user_id text primary key,
  master_id bigint not null references public.masters (id) on delete cascade,
  step text not null check (step in ('lang', 'contact', 'first_name', 'last_name', 'known_before', 'surname')),
  lang text check (lang in ('ru', 'uz')),
  tg_username text,
  phone_e164 text,
  client_id uuid references public.clients (id) on delete cascade,
  first_name text,
  last_name text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.mirror_sessions enable row level security;
revoke all on table public.mirror_sessions from public, anon, authenticated;

-- What the bot needs of a session: its step, language and master's names.
create or replace function public.maestro_mirror_view(p_session public.mirror_sessions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'step', p_session.step,
    'lang', p_session.lang,
    'first_name', coalesce(p_session.first_name, client.first_name, public.maestro_name_part(client.full_name)),
    'master_name', master.name,
    'master_name_uz', coalesce(master.name_uz, master.name)
  )
  from public.masters as master
  left join public.clients as client on client.id = p_session.client_id
  where master.id = p_session.master_id
$$;

-- The live session of a Telegram user, locked; an old one is dropped.
create or replace function public.maestro_mirror_current(p_tg_user_id text)
returns public.mirror_sessions
language plpgsql
set search_path = ''
as $$
declare
  session_record public.mirror_sessions;
begin
  select * into session_record from public.mirror_sessions where tg_user_id = p_tg_user_id for update;
  if not found then return null; end if;
  if session_record.updated_at < now() - interval '20 minutes' then
    delete from public.mirror_sessions where tg_user_id = p_tg_user_id;
    return null;
  end if;
  return session_record;
end;
$$;

-- /start m_<code>: a new session at the language question.
create or replace function public.maestro_mirror_begin(p_code text, p_tg_user_id text, p_tg_username text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  master_id bigint;
  session_record public.mirror_sessions;
begin
  select id into master_id from public.masters where mirror_code = lower(btrim(p_code)) and active;
  if master_id is null then return jsonb_build_object('ok', false, 'error', 'unknown_code'); end if;
  if exists (select 1 from public.app_users where active and telegram_id::text = p_tg_user_id) then
    return jsonb_build_object('ok', false, 'error', 'staff_account');
  end if;
  insert into public.mirror_sessions (tg_user_id, master_id, step, tg_username)
  values (p_tg_user_id, master_id, 'lang', nullif(btrim(p_tg_username), ''))
  on conflict (tg_user_id) do update set
    master_id = excluded.master_id, step = 'lang', lang = null, tg_username = excluded.tg_username,
    phone_e164 = null, client_id = null, first_name = null, last_name = null,
    started_at = now(), updated_at = now()
  returning * into session_record;
  return jsonb_build_object('ok', true) || public.maestro_mirror_view(session_record);
end;
$$;

-- The session as it stands, or nothing: a contact or a typed word belongs to
-- the mirror only while one is open.
create or replace function public.maestro_mirror_session(p_tg_user_id text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  session_record public.mirror_sessions;
begin
  session_record := public.maestro_mirror_current(p_tg_user_id);
  if session_record.tg_user_id is null then return null; end if;
  return public.maestro_mirror_view(session_record);
end;
$$;

-- A site booking started in the bot: the mirror's questions are over.
create or replace function public.maestro_mirror_drop(p_tg_user_id text)
returns void
language sql
set search_path = ''
as $$
  delete from public.mirror_sessions where tg_user_id = p_tg_user_id
$$;

create or replace function public.maestro_mirror_lang(p_tg_user_id text, p_lang text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  session_record public.mirror_sessions;
begin
  if p_lang not in ('ru', 'uz') then return jsonb_build_object('ok', false, 'error', 'invalid_lang'); end if;
  session_record := public.maestro_mirror_current(p_tg_user_id);
  if session_record.tg_user_id is null then return jsonb_build_object('ok', false, 'error', 'no_session'); end if;
  update public.mirror_sessions
     set lang = p_lang,
         step = case when step = 'lang' then 'contact' else step end,
         updated_at = now()
   where tg_user_id = p_tg_user_id
  returning * into session_record;
  return jsonb_build_object('ok', true) || public.maestro_mirror_view(session_record);
end;
$$;

-- The end of the questions: the card (found, given its missing surname, or
-- made), the client's Telegram on it, and the scan for the master.
create or replace function public.maestro_mirror_finish(p_tg_user_id text, p_known_before boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  session_record public.mirror_sessions;
  card public.clients;
  created boolean := false;
begin
  select * into session_record from public.mirror_sessions where tg_user_id = p_tg_user_id for update;
  if not found or session_record.phone_e164 is null then
    return jsonb_build_object('ok', false, 'error', 'no_session');
  end if;

  -- The card of the number; one may have been made since the contact came.
  select * into card from public.clients
   where id = session_record.client_id or phone_e164 = session_record.phone_e164
   order by (id = session_record.client_id) desc nulls last
   limit 1
   for update;

  if card.lifecycle_status = 'blocked' then
    delete from public.mirror_sessions where tg_user_id = p_tg_user_id;
    return jsonb_build_object('ok', false, 'error', 'client_blocked');
  end if;

  if card.id is null then
    if session_record.first_name is null or session_record.last_name is null then
      return jsonb_build_object('ok', false, 'error', 'no_name');
    end if;
    insert into public.clients (
      full_name, first_name, last_name, phone_e164, known_before, preferred_language,
      first_source, last_source, first_contact_at, last_contact_at
    ) values (
      session_record.first_name || ' ' || session_record.last_name,
      session_record.first_name, session_record.last_name, session_record.phone_e164,
      coalesce(p_known_before, false), coalesce(session_record.lang, 'unknown'),
      'mirror', 'mirror', now(), now()
    )
    returning * into card;
    created := true;
    insert into public.client_events (client_id, event_type, source, details)
    values (card.id, 'card_created', 'mirror', jsonb_build_object('master_id', session_record.master_id,
      'known_before', coalesce(p_known_before, false)));
  elsif card.last_name is null and session_record.last_name is not null then
    update public.clients
       set first_name = coalesce(first_name, public.maestro_name_part(full_name)),
           last_name = session_record.last_name,
           updated_at = now()
     where id = card.id
    returning * into card;
    perform public.maestro_sync_client_name(card.id);
    insert into public.client_events (client_id, event_type, source, details)
    values (card.id, 'card_edited', 'mirror', jsonb_build_object('surname_added', session_record.last_name));
  end if;

  -- The Telegram account now belongs to this number; an older card that
  -- carried it under another number lets go of it (as a site booking does).
  update public.clients set telegram_user_id = null, updated_at = now()
   where telegram_user_id = p_tg_user_id and id <> card.id;
  update public.clients
     set telegram_user_id = p_tg_user_id,
         telegram_username = coalesce(session_record.tg_username, telegram_username),
         preferred_language = coalesce(session_record.lang, preferred_language),
         last_source = 'mirror', last_contact_at = now(), updated_at = now()
   where id = card.id
  returning * into card;

  insert into public.client_scans (client_id, master_id) values (card.id, session_record.master_id);
  insert into public.client_events (client_id, event_type, source, details)
  values (card.id, 'mirror_scan', 'mirror', jsonb_build_object('master_id', session_record.master_id));

  delete from public.mirror_sessions where tg_user_id = p_tg_user_id;
  return jsonb_build_object('ok', true, 'next', 'done', 'created', created, 'client_id', card.id)
    || public.maestro_mirror_view(session_record)
    || jsonb_build_object('first_name', card.first_name);
end;
$$;

-- The number, the user's own (the bot checks the contact is his). A complete
-- card ends the questions at once; one without a surname asks for it; a new
-- number asks for the name.
create or replace function public.maestro_mirror_contact(p_tg_user_id text, p_phone text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  session_record public.mirror_sessions;
  phone text;
  card public.clients;
begin
  session_record := public.maestro_mirror_current(p_tg_user_id);
  if session_record.tg_user_id is null then return jsonb_build_object('ok', false, 'error', 'no_session'); end if;
  phone := public.maestro_normalize_phone(p_phone);
  if phone is null then return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;

  select * into card from public.clients where phone_e164 = phone;
  if card.lifecycle_status = 'blocked' then
    delete from public.mirror_sessions where tg_user_id = p_tg_user_id;
    return jsonb_build_object('ok', false, 'error', 'client_blocked');
  end if;

  update public.mirror_sessions
     set phone_e164 = phone,
         client_id = card.id,
         step = case when card.id is null then 'first_name' when card.last_name is null then 'surname' else step end,
         updated_at = now()
   where tg_user_id = p_tg_user_id
  returning * into session_record;

  if card.id is not null and card.last_name is not null then
    return public.maestro_mirror_finish(p_tg_user_id, null);
  end if;
  return jsonb_build_object('ok', true, 'next', session_record.step) || public.maestro_mirror_view(session_record);
end;
$$;

-- A name, a surname, or the surname a card lacks, as the client typed it
-- (the bot has already tidied the capitals). Two letters at least, no digits.
create or replace function public.maestro_mirror_name(p_tg_user_id text, p_part text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  session_record public.mirror_sessions;
  part text := public.maestro_name_part(p_part);
begin
  session_record := public.maestro_mirror_current(p_tg_user_id);
  if session_record.tg_user_id is null then return jsonb_build_object('ok', false, 'error', 'no_session'); end if;
  if session_record.step not in ('first_name', 'last_name', 'surname') then
    return jsonb_build_object('ok', false, 'error', 'not_asked') || public.maestro_mirror_view(session_record);
  end if;
  if not public.maestro_name_part_ok(part) then
    return jsonb_build_object('ok', false, 'error', 'invalid_name') || public.maestro_mirror_view(session_record);
  end if;

  if session_record.step = 'first_name' then
    update public.mirror_sessions set first_name = part, step = 'last_name', updated_at = now()
     where tg_user_id = p_tg_user_id returning * into session_record;
  elsif session_record.step = 'last_name' then
    update public.mirror_sessions set last_name = part, step = 'known_before', updated_at = now()
     where tg_user_id = p_tg_user_id returning * into session_record;
  else
    update public.mirror_sessions set last_name = part, updated_at = now()
     where tg_user_id = p_tg_user_id;
    return public.maestro_mirror_finish(p_tg_user_id, null);
  end if;
  return jsonb_build_object('ok', true, 'next', session_record.step) || public.maestro_mirror_view(session_record);
end;
$$;

-- «Вы уже были у нас в Maestro?»: the last question for a new number.
create or replace function public.maestro_mirror_known(p_tg_user_id text, p_known_before boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  session_record public.mirror_sessions;
begin
  session_record := public.maestro_mirror_current(p_tg_user_id);
  if session_record.tg_user_id is null then return jsonb_build_object('ok', false, 'error', 'no_session'); end if;
  if session_record.step <> 'known_before' then
    return jsonb_build_object('ok', false, 'error', 'not_asked') || public.maestro_mirror_view(session_record);
  end if;
  return public.maestro_mirror_finish(p_tg_user_id, p_known_before);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_mirror_view(public.mirror_sessions)',
    'public.maestro_mirror_current(text)',
    'public.maestro_mirror_begin(text, text, text)',
    'public.maestro_mirror_session(text)',
    'public.maestro_mirror_drop(text)',
    'public.maestro_mirror_lang(text, text)',
    'public.maestro_mirror_finish(text, boolean)',
    'public.maestro_mirror_contact(text, text)',
    'public.maestro_mirror_name(text, text)',
    'public.maestro_mirror_known(text, boolean)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
