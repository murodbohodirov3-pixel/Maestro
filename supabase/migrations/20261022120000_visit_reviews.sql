-- Clients rate their visit (owner's decisions of 2026-10-21). Ten minutes
-- after a master records a visit, @MaestroBarberia_bot asks the client four
-- questions, 1 to 5 each, one message that shows «Вопрос N из 4»: the work,
-- the service, cleanliness and hygiene, and the comfort of the salon; then
-- a few words. A master's rating is the mean of the first three:
-- the comfort of the salon is the owner's to read, not the master's. A score
-- of 3 or less reaches the owner at once. Words reach the site only once the
-- owner has approved them, and then all of them. A master reads every word
-- about him and never which reached the site: he is to expect them all there.
--
-- Telegram lets a bot write only to whoever started it, so only the clients
-- who have written to @MaestroBarberia_bot are asked (client_bot_chats).

-- --------------------------------------------- who started the clients' bot
create table if not exists public.client_bot_chats (
  tg_user_id text primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Telegram said the user blocked the bot; writing to him again comes back
  -- to nothing until he writes himself.
  blocked_at timestamptz
);
alter table public.client_bot_chats enable row level security;
revoke all on table public.client_bot_chats from public, anon, authenticated;

-- Those who confirmed a site booking with it since 2026-10-21.
insert into public.client_bot_chats (tg_user_id, first_seen_at, last_seen_at)
select booking_tg_user_id, min(created_at), max(updated_at)
  from public.appointments
 where booking_bot = 'client' and booking_tg_user_id is not null
 group by booking_tg_user_id
on conflict (tg_user_id) do nothing;

create or replace function public.maestro_client_bot_seen(p_tg_user_id text)
returns void
language sql
set search_path = ''
as $$
  insert into public.client_bot_chats (tg_user_id) values (p_tg_user_id)
  on conflict (tg_user_id) do update set last_seen_at = now(), blocked_at = null
$$;

-- ------------------------------------------------------------ the reviews
create table if not exists public.visit_reviews (
  id bigint generated always as identity primary key,
  sale_id bigint not null unique references public.sales (id) on delete cascade,
  master_id bigint not null references public.masters (id) on delete cascade,
  tg_user_id text not null,
  lang text not null default 'ru' check (lang in ('ru', 'uz')),
  -- asking: the four questions; comment: waiting for the words; done; the
  -- client could not be written to; or 24 hours went by unanswered.
  status text not null default 'asking' check (status in ('asking', 'comment', 'done', 'unreachable', 'expired')),
  step smallint not null default 1 check (step between 1 and 4),
  quality smallint check (quality between 1 and 5),
  service smallint check (service between 1 and 5),
  cleanliness smallint check (cleanliness between 1 and 5),
  comfort smallint check (comfort between 1 and 5),
  comment text check (comment is null or char_length(comment) between 1 and 600),
  comment_status text check (comment_status in ('pending', 'approved', 'hidden')),
  message_id bigint,
  asked_at timestamptz not null default now(),
  rated_at timestamptz,
  commented_at timestamptz,
  decided_at timestamptz,
  decided_by_user_id bigint references public.app_users (id) on delete set null
);
create index if not exists visit_reviews_master_idx on public.visit_reviews (master_id, asked_at desc);
create index if not exists visit_reviews_waiting_idx on public.visit_reviews (tg_user_id, asked_at desc)
  where status in ('asking', 'comment');
alter table public.visit_reviews enable row level security;
revoke all on table public.visit_reviews from public, anon, authenticated;

-- The visits whose client may be asked now: recorded between ten minutes
-- and six hours ago (a visit found later is let go), not a guest, not
-- rejected, a client who started the bot and is not staff, not asked about
-- this visit, and not asked about another in the last 20 hours.
create or replace function public.maestro_review_candidates()
returns table (sale_id bigint, master_id bigint, tg_user_id text, lang text)
language sql
stable
set search_path = ''
as $$
  select distinct on (client.telegram_user_id)
         sale.id, sale.master_id, client.telegram_user_id,
         case when client.preferred_language = 'uz' then 'uz' else 'ru' end
    from public.sales as sale
    join public.clients as client on client.id = sale.client_id
    join public.client_bot_chats as chat on chat.tg_user_id = client.telegram_user_id and chat.blocked_at is null
   where sale.created_at between now() - interval '6 hours' and now() - interval '10 minutes'
     and sale.master_id is not null
     and not sale.is_guest
     and not public.maestro_sale_is_rejected(sale.status, sale.comment)
     and not exists (select 1 from public.app_users as staff
                      where staff.active and staff.telegram_id::text = client.telegram_user_id)
     and not exists (select 1 from public.visit_reviews as review where review.sale_id = sale.id)
     and not exists (select 1 from public.visit_reviews as review
                      where review.tg_user_id = client.telegram_user_id
                        and review.asked_at > now() - interval '20 hours')
   order by client.telegram_user_id, sale.created_at
$$;

-- pg_cron asks booking-bot only when there is someone to ask.
create or replace function public.maestro_review_invites_due()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.maestro_review_candidates())
      or exists (select 1 from public.visit_reviews
                  where status in ('asking', 'comment') and asked_at < now() - interval '24 hours')
$$;

-- The questions to send now, each kept as asked so it is sent once; and
-- those left unanswered for a day are closed (the scores given stay).
create or replace function public.maestro_claim_review_invites(p_limit integer)
returns table (review_id bigint, tg_user_id text, lang text, master_name text, master_name_uz text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.visit_reviews
     set status = case when status = 'comment' then 'done' else 'expired' end
   where status in ('asking', 'comment') and asked_at < now() - interval '24 hours';

  return query
  with picked as (
    select candidate.* from public.maestro_review_candidates() as candidate
    limit greatest(1, least(coalesce(p_limit, 20), 50))
  ),
  made as (
    insert into public.visit_reviews (sale_id, master_id, tg_user_id, lang)
    select picked.sale_id, picked.master_id, picked.tg_user_id, picked.lang from picked
    on conflict (sale_id) do nothing
    returning visit_reviews.id, visit_reviews.tg_user_id, visit_reviews.lang, visit_reviews.master_id
  )
  select made.id, made.tg_user_id, made.lang, master.name, coalesce(master.name_uz, master.name)
    from made join public.masters as master on master.id = made.master_id;
end;
$$;

create or replace function public.maestro_review_sent(p_review_id bigint, p_message_id bigint)
returns void
language sql
set search_path = ''
as $$
  update public.visit_reviews set message_id = p_message_id where id = p_review_id
$$;

-- Telegram would not deliver: the client is not asked again until he writes.
create or replace function public.maestro_review_unreachable(p_review_id bigint)
returns void
language sql
set search_path = ''
as $$
  update public.visit_reviews set status = 'unreachable' where id = p_review_id;
  update public.client_bot_chats set blocked_at = now()
   where tg_user_id = (select tg_user_id from public.visit_reviews where id = p_review_id);
$$;

-- What the bot says about a review: its scores, its master, its client.
create or replace function public.maestro_review_view(p_review public.visit_reviews)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'review_id', p_review.id,
    'status', p_review.status,
    'step', p_review.step,
    'lang', p_review.lang,
    'quality', p_review.quality,
    'service', p_review.service,
    'cleanliness', p_review.cleanliness,
    'comfort', p_review.comfort,
    'comment', p_review.comment,
    'master_name', master.name,
    'master_name_uz', coalesce(master.name_uz, master.name),
    'client_name', client.full_name,
    'client_phone', client.phone_e164,
    'visit_date', sale.d
  )
  from public.sales as sale
  join public.masters as master on master.id = p_review.master_id
  left join public.clients as client on client.id = sale.client_id
  where sale.id = p_review.sale_id
$$;

-- One tap: the score of the question it was asked for. A tap on a question
-- already answered, or on another person's message, changes nothing.
create or replace function public.maestro_review_answer(p_review_id bigint, p_tg_user_id text, p_step integer, p_score integer)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  review public.visit_reviews;
begin
  select * into review from public.visit_reviews where id = p_review_id for update;
  if not found or review.tg_user_id is distinct from p_tg_user_id then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if review.status <> 'asking' or review.step <> p_step or p_score not between 1 and 5 then
    return jsonb_build_object('ok', false, 'error', 'stale');
  end if;

  update public.visit_reviews
     set quality = case when p_step = 1 then p_score else quality end,
         service = case when p_step = 2 then p_score else service end,
         cleanliness = case when p_step = 3 then p_score else cleanliness end,
         comfort = case when p_step = 4 then p_score else comfort end,
         step = least(p_step + 1, 4),
         status = case when p_step = 4 then 'comment' else 'asking' end,
         rated_at = case when p_step = 4 then now() else rated_at end
   where id = p_review_id
  returning * into review;

  return jsonb_build_object('ok', true, 'rated', review.status = 'comment',
    'low', review.status = 'comment' and least(review.quality, review.service, review.cleanliness, review.comfort) <= 3)
    || public.maestro_review_view(review);
end;
$$;

-- Is this Telegram user's next message the words of a review?
create or replace function public.maestro_review_waiting_words(p_tg_user_id text)
returns bigint
language sql
stable
set search_path = ''
as $$
  select id from public.visit_reviews
   where tg_user_id = p_tg_user_id and status = 'comment' and asked_at > now() - interval '24 hours'
   order by asked_at desc
   limit 1
$$;

create or replace function public.maestro_review_words(p_tg_user_id text, p_text text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  review public.visit_reviews;
  words text := left(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')), 600);
begin
  select * into review from public.visit_reviews
   where id = public.maestro_review_waiting_words(p_tg_user_id)
   for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if char_length(words) < 2 then return jsonb_build_object('ok', false, 'error', 'too_short'); end if;
  update public.visit_reviews
     set comment = words, comment_status = 'pending', commented_at = now(), status = 'done'
   where id = review.id
  returning * into review;
  return jsonb_build_object('ok', true) || public.maestro_review_view(review);
end;
$$;

-- The owner shows a review's words on the site, or keeps them off it.
create or replace function public.maestro_decide_review_words(p_review_id bigint, p_status text, p_actor_user_id bigint)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  review public.visit_reviews;
begin
  if p_status not in ('approved', 'hidden') then return jsonb_build_object('ok', false, 'error', 'invalid_status'); end if;
  update public.visit_reviews
     set comment_status = p_status, decided_at = now(), decided_by_user_id = p_actor_user_id
   where id = p_review_id and comment is not null
  returning * into review;
  if review.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'review_id', review.id, 'comment_status', review.comment_status);
end;
$$;

-- A master's rating: the mean of the work, the service and cleanliness over
-- every visit rated, rejected visits left out; and each question's own mean.
create or replace function public.maestro_master_ratings()
returns table (
  master_id bigint, ratings integer, rating numeric,
  quality numeric, service numeric, cleanliness numeric, comfort numeric
)
language sql
stable
set search_path = ''
as $$
  select review.master_id,
         count(*)::integer,
         round(avg((review.quality + review.service + review.cleanliness) / 3.0), 1),
         round(avg(review.quality), 1), round(avg(review.service), 1),
         round(avg(review.cleanliness), 1), round(avg(review.comfort), 1)
    from public.visit_reviews as review
    join public.sales as sale on sale.id = review.sale_id
   where review.quality is not null and review.service is not null and review.cleanliness is not null
     and not public.maestro_sale_is_rejected(sale.status, sale.comment)
   group by review.master_id
$$;

-- What the booking page shows of a master: his rating once three visits are
-- rated, and every word the owner approved, newest first, signed «Сардор К.».
create or replace function public.maestro_public_reviews()
returns table (master_id bigint, rating numeric, ratings integer, reviews jsonb)
language sql
stable
set search_path = ''
as $$
  select master.id,
         case when rated.ratings >= 3 then rated.rating end,
         coalesce(rated.ratings, 0),
         coalesce((
           select jsonb_agg(jsonb_build_object('text', latest.comment, 'author', latest.author, 'date', latest.d) order by latest.commented_at desc)
             from (
               select review.comment, review.commented_at, sale.d,
                      coalesce(client.first_name, public.maestro_name_part(split_part(client.full_name, ' ', 1)), '')
                        || coalesce(' ' || left(client.last_name, 1) || '.', '') as author
                 from public.visit_reviews as review
                 join public.sales as sale on sale.id = review.sale_id
                 left join public.clients as client on client.id = sale.client_id
                where review.master_id = master.id and review.comment_status = 'approved'
                  and not public.maestro_sale_is_rejected(sale.status, sale.comment)
                order by review.commented_at desc
             ) as latest
         ), '[]'::jsonb)
    from public.masters as master
    left join public.maestro_master_ratings() as rated on rated.master_id = master.id
   where master.active and master.show_online
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_client_bot_seen(text)',
    'public.maestro_review_candidates()',
    'public.maestro_review_invites_due()',
    'public.maestro_claim_review_invites(integer)',
    'public.maestro_review_sent(bigint, bigint)',
    'public.maestro_review_unreachable(bigint)',
    'public.maestro_review_view(public.visit_reviews)',
    'public.maestro_review_answer(bigint, text, integer, integer)',
    'public.maestro_review_waiting_words(text)',
    'public.maestro_review_words(text, text)',
    'public.maestro_decide_review_words(bigint, text, bigint)',
    'public.maestro_master_ratings()',
    'public.maestro_public_reviews()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- Every minute, when someone is to be asked: ten minutes after the visit,
-- not fifteen.
select cron.schedule(
  'maestro-review-invites',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://ivowbhraaistxvoymxpf.supabase.co/functions/v1/booking-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-booking-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'booking_cron_secret')
    ),
    body := '{"action":"reviews"}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id
  where public.maestro_review_invites_due();
  $job$
);
