-- 2026-10-17. Two client cards were tied in July to staff Telegram accounts by
-- the old system: the salon's account (now the administrator's) to Oybek's
-- card, the owner's to a test card «Иван Иванов». The booking bot took those
-- links for the person's own number, so the owner's test booking «Мурод» from
-- the salon's account came with Oybek's number and renamed his card.
-- Oybek's card gets its name back and both cards let go of the staff accounts;
-- the cancelled test booking is deleted (owner's decision of 2026-10-17), with
-- the three lines it left in Oybek's history. Each change only if the row is
-- still as found.

update public.clients
   set full_name = 'Oybek', telegram_user_id = null, telegram_username = null, updated_at = now()
 where id = '4ab0c519-196b-492f-89cd-4392f9e6d3ce'
   and full_name = 'Мурод'
   and telegram_user_id = '8234877309';

delete from public.client_events
 where client_id = '4ab0c519-196b-492f-89cd-4392f9e6d3ce'
   and source = 'web'
   and (appointment_id = '2e50baea-c40d-4be1-9b8f-8967f616ec6b' or (event_type = 'contact_captured' and created_at = '2026-10-16 18:04:16.655446+00'))
   and exists (select 1 from public.appointments where id = '2e50baea-c40d-4be1-9b8f-8967f616ec6b' and source = 'web' and status = 'cancelled' and client_name = 'Мурод');

delete from public.appointments
 where id = '2e50baea-c40d-4be1-9b8f-8967f616ec6b'
   and source = 'web' and status = 'cancelled' and client_name = 'Мурод';

update public.clients
   set telegram_user_id = null, updated_at = now()
 where id = '16142fae-3a66-41c3-8c2e-6c34164235f4'
   and telegram_user_id = (select telegram_id::text from public.app_users where id = 7);

select jsonb_build_object(
  'oybek', (select jsonb_build_object('name', full_name, 'tg', telegram_user_id, 'phone_tail', right(phone_e164, 4)) from public.clients where id = '4ab0c519-196b-492f-89cd-4392f9e6d3ce'),
  'test_booking_left', (select count(*) from public.appointments where id = '2e50baea-c40d-4be1-9b8f-8967f616ec6b'),
  'oybek_web_events_left', (select count(*) from public.client_events where client_id = '4ab0c519-196b-492f-89cd-4392f9e6d3ce' and source = 'web'),
  'cards_on_staff_accounts', (select count(*) from public.clients c join public.app_users u on u.telegram_id::text = c.telegram_user_id)
) as result;
