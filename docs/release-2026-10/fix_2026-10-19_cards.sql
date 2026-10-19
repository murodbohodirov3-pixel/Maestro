-- 2026-10-19, owner's decision of the same day. Each change only if the rows
-- are still as found.
--
-- 1. Iskandarov Anvar. Жамолиддин booked him on the site from his own
--    Telegram, so the card took Жамолиддин's number and account, and
--    «Написать» opened Жамолиддин. The owner has corrected the number; the
--    card now lets go of the staff account.
update public.clients
   set telegram_user_id = null, telegram_username = null, updated_by_user_id = 7, updated_at = now()
 where id = '967c4c66-22d1-4a63-a97b-2662fa20295c'
   and telegram_user_id = (select telegram_id::text from public.app_users where id = 4);

-- 2. Валерий Сиднев booked himself on the site to Зиёдулла for 17.10 at 17:15,
--    came, and was cut by Жавлон, who entered him on a new card with the
--    surname (sale 4377). Зиёдулла marked the booking a no-show. The site card
--    is merged into Жавлон's (its Telegram goes with it, so the bot still
--    knows him), and the booking passes to Жавлон as visited, tied to that
--    sale, so the visit is counted once.
select public.maestro_merge_clients('a2d2f12f-59cd-41c1-974f-03faab8ddd15', '4a98f4f4-2ccc-4a10-9803-6dbd4488b724', 7)
 where exists (select 1 from public.clients where id = 'a2d2f12f-59cd-41c1-974f-03faab8ddd15');

with fixed as (
  update public.appointments
     set master_id = 3, status = 'completed', no_show_at = null,
         status_reason_code = null, status_reason_note = null,
         client_id = '4a98f4f4-2ccc-4a10-9803-6dbd4488b724',
         updated_by_user_id = 7, updated_at = now()
   where id = '11abf55d-dca8-4629-9648-8c9d731a11dd' and status = 'no_show' and master_id = 21
  returning id
)
insert into public.appointment_events (appointment_id, event_type, old_values, new_values, actor_user_id)
select id, 'status_changed',
  jsonb_build_object('status', 'no_show', 'master_id', 21, 'status_reason_code', 'no_show_no_notice'),
  jsonb_build_object('status', 'completed', 'master_id', 3, 'via', 'owner_correction', 'sale_id', 4377),
  7
from fixed;

update public.sales
   set appointment_id = '11abf55d-dca8-4629-9648-8c9d731a11dd'
 where id = 4377 and appointment_id is null and client_id = '4a98f4f4-2ccc-4a10-9803-6dbd4488b724';

select jsonb_build_object(
  'iskandarov', (select jsonb_build_object('phone', phone_e164, 'tg', telegram_user_id, 'username', telegram_username) from public.clients where id = '967c4c66-22d1-4a63-a97b-2662fa20295c'),
  'cards_on_staff_accounts', (select count(*) from public.clients c join public.app_users u on u.telegram_id::text = c.telegram_user_id),
  'valeriy_site_card_left', (select count(*) from public.clients where id = 'a2d2f12f-59cd-41c1-974f-03faab8ddd15'),
  'valeriy_card', (select jsonb_build_object('name', full_name, 'phone', phone_e164, 'tg_linked', telegram_user_id is not null) from public.clients where id = '4a98f4f4-2ccc-4a10-9803-6dbd4488b724'),
  'valeriy_visits', public.maestro_client_visit_count('4a98f4f4-2ccc-4a10-9803-6dbd4488b724'),
  'booking', (select jsonb_build_object('master', m.name, 'status', a.status, 'client', a.client_name, 'sale', (select id from public.sales where appointment_id = a.id))
                from public.appointments a join public.masters m on m.id = a.master_id where a.id = '11abf55d-dca8-4629-9648-8c9d731a11dd'),
  'ziyodulla_no_shows_17', (select count(*) from public.appointments where master_id = 21 and status = 'no_show' and starts_at >= '2026-10-17T00:00:00+05' and starts_at < '2026-10-18T00:00:00+05')
) as result;
