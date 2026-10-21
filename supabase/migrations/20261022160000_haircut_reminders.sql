-- «Пора подстричься» (owner's decisions of 2026-10-21): fifteen days after a
-- client's last visit, @MaestroBarberia_bot writes «{Имя}, прошло 15 дней с
-- вашей прошлой стрижки. Не забудьте уделить время себе! С уважением, Maestro
-- Barberia», with «📅 Записаться» and «Не напоминать»; if he has still not
-- come, the same at thirty days; then nothing until his next visit, which
-- starts the count again. At 11:00 in Tashkent, never at night.
--
-- Only those who have written to the bot can be written to (client_bot_chats).
-- A client with a booking ahead is coming anyway and hears nothing; one who
-- pressed «Не напоминать» has his marketing consent denied and hears nothing.
-- Each window has a few days of grace, so a missed morning does not lose a
-- reminder, and a client last seen long ago is not told «30 дней».

create table if not exists public.haircut_reminders (
  id bigint generated always as identity primary key,
  client_id uuid not null references public.clients (id) on delete cascade,
  tg_user_id text not null,
  last_visit_on date not null,
  days smallint not null check (days in (15, 30)),
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (client_id, last_visit_on, days)
);
alter table public.haircut_reminders enable row level security;
revoke all on table public.haircut_reminders from public, anon, authenticated;

-- Who is to be reminded today: the day of his last counted visit, how many
-- days ago that was, and which of the two reminders is due.
create or replace function public.maestro_haircut_candidates()
returns table (client_id uuid, tg_user_id text, lang text, first_name text, last_visit_on date, days_since integer, kind smallint)
language sql
stable
set search_path = ''
as $$
  with today as (select (now() at time zone 'Asia/Tashkent')::date as day),
  last_visit as (
    select sale.client_id, max(sale.d) as day
      from public.sales as sale
     where sale.client_id is not null
       and not public.maestro_sale_is_rejected(sale.status, sale.comment)
     group by sale.client_id
  )
  select client.id, client.telegram_user_id,
         case when client.preferred_language = 'uz' then 'uz' else 'ru' end,
         coalesce(client.first_name, public.maestro_name_part(split_part(client.full_name, ' ', 1))),
         last_visit.day,
         (today.day - last_visit.day)::integer,
         (case when today.day - last_visit.day >= 30 then 30 else 15 end)::smallint
    from last_visit
    cross join today
    join public.clients as client on client.id = last_visit.client_id
    join public.client_bot_chats as chat on chat.tg_user_id = client.telegram_user_id and chat.blocked_at is null
   where ((today.day - last_visit.day) between 15 and 20 or (today.day - last_visit.day) between 30 and 36)
     and client.lifecycle_status <> 'blocked'
     and client.marketing_consent <> 'denied'
     and not exists (select 1 from public.app_users as staff
                      where staff.active and staff.telegram_id::text = client.telegram_user_id)
     -- Already coming: a booking ahead.
     and not exists (select 1 from public.appointments as booking
                      where booking.client_id = client.id and booking.status in ('confirmed', 'pending')
                        and booking.starts_at > now())
     and not exists (select 1 from public.haircut_reminders as reminder
                      where reminder.client_id = client.id and reminder.last_visit_on = last_visit.day
                        and reminder.days = (case when today.day - last_visit.day >= 30 then 30 else 15 end))
$$;

create or replace function public.maestro_haircut_reminders_due()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.maestro_haircut_candidates())
$$;

-- The reminders to send now, each kept as claimed so it goes out once.
create or replace function public.maestro_claim_haircut_reminders(p_limit integer)
returns table (reminder_id bigint, tg_user_id text, lang text, first_name text, days_since integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select candidate.* from public.maestro_haircut_candidates() as candidate
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ),
  made as (
    insert into public.haircut_reminders (client_id, tg_user_id, last_visit_on, days)
    select picked.client_id, picked.tg_user_id, picked.last_visit_on, picked.kind from picked
    on conflict (client_id, last_visit_on, days) do nothing
    returning haircut_reminders.id, haircut_reminders.client_id
  )
  select made.id, picked.tg_user_id, picked.lang, picked.first_name, picked.days_since
    from made join picked on picked.client_id = made.client_id;
end;
$$;

-- What Telegram said. A refusal marks the chat as blocked, as a rating does.
create or replace function public.maestro_haircut_reminder_done(p_reminder_id bigint, p_sent boolean, p_blocked boolean)
returns void
language sql
set search_path = ''
as $$
  update public.haircut_reminders
     set status = case when p_sent then 'sent' else 'failed' end,
         sent_at = case when p_sent then now() else null end
   where id = p_reminder_id;
  update public.client_bot_chats set blocked_at = now()
   where p_blocked and tg_user_id = (select tg_user_id from public.haircut_reminders where id = p_reminder_id);
$$;

-- «Не напоминать»: the client's marketing consent is denied, with its record.
create or replace function public.maestro_haircut_reminders_off(p_tg_user_id text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  card public.clients;
begin
  update public.clients
     set marketing_consent = 'denied', marketing_consent_at = now(), updated_at = now()
   where telegram_user_id = p_tg_user_id
  returning * into card;
  if card.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  insert into public.client_consent_events (client_id, channel, decision, consent_text_version, source)
  values (card.id, 'telegram', 'withdrawn', 'haircut_reminders_2026_10', 'client_bot');
  return jsonb_build_object('ok', true, 'lang', case when card.preferred_language = 'uz' then 'uz' else 'ru' end);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_haircut_candidates()',
    'public.maestro_haircut_reminders_due()',
    'public.maestro_claim_haircut_reminders(integer)',
    'public.maestro_haircut_reminder_done(bigint, boolean, boolean)',
    'public.maestro_haircut_reminders_off(text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- 11:00 in Tashkent is 06:00 UTC.
select cron.schedule(
  'maestro-haircut-reminders',
  '0 6 * * *',
  $job$
  select net.http_post(
    url := 'https://ivowbhraaistxvoymxpf.supabase.co/functions/v1/booking-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-booking-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'booking_cron_secret')
    ),
    body := '{"action":"haircut_reminders"}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id
  where public.maestro_haircut_reminders_due();
  $job$
);
