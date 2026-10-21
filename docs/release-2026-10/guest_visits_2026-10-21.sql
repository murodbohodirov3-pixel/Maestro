-- 2026-10-21, after 20261021150000_guest_visits.sql (owner's decisions of the
-- same day): six cards that are not clients go.
-- - «Klent» twice and «Клиент отказался» were made for clients who would not
--   give their name; their one visit each becomes a guest's.
-- - «I», «Да да» and «Иван Иванов» were tries of the old calendar and bot in
--   July and August; their try bookings (one each, no sale) go with them.
-- Each card is copied whole into audit_events first, with its events,
-- consents and bookings (and those bookings' events and notices), so it can
-- be put back.
begin;

create temporary table removed_cards on commit drop as
select client.*
  from public.clients as client
 where client.id in (
         '2adb5883-6d0e-4764-a5bf-98be11f8c890',  -- Klent
         '929ae361-886e-4893-9852-5ac4366d485f',  -- Klent
         'de66436a-e41b-469c-a77f-4600de5e5392',  -- Клиент отказался
         '52d9ca4c-251a-4aa1-a32b-494f6219ea26',  -- I
         '7236b26a-debd-4788-957e-d90b283c4474',  -- Да да
         '16142fae-3a66-41c3-8c2e-6c34164235f4'   -- Иван Иванов
       )
   and client.first_name is null;

insert into public.audit_events (entity_type, entity_id, operation, event_name, source, old_values, metadata)
select 'client', card.id::text, 'delete', 'client.deleted', 'release_2026_10_21_guest_visits', to_jsonb(card),
       jsonb_build_object(
         'reason', 'not_a_client',
         'visits_made_guest', (select coalesce(jsonb_agg(sale.id order by sale.id), '[]'::jsonb)
                                 from public.sales as sale where sale.client_id = card.id),
         'events', (select coalesce(jsonb_agg(to_jsonb(event) order by event.id), '[]'::jsonb)
                      from public.client_events as event where event.client_id = card.id),
         'consents', (select coalesce(jsonb_agg(to_jsonb(consent) order by consent.id), '[]'::jsonb)
                        from public.client_consent_events as consent where consent.client_id = card.id),
         'bookings', (select coalesce(jsonb_agg(jsonb_build_object(
                         'booking', to_jsonb(booking),
                         'events', (select coalesce(jsonb_agg(to_jsonb(booking_event)), '[]'::jsonb)
                                      from public.appointment_events as booking_event
                                     where booking_event.appointment_id = booking.id),
                         'notices', (select coalesce(jsonb_agg(to_jsonb(notice)), '[]'::jsonb)
                                       from public.appointment_notification_deliveries as notice
                                      where notice.appointment_id = booking.id)
                       ) order by booking.starts_at), '[]'::jsonb)
                        from public.appointments as booking where booking.client_id = card.id))
  from removed_cards as card;

update public.sales as sale
   set client_id = null, client_name = 'Гость без имени', client_no_phone = true, is_guest = true
 where sale.client_id in (select id from removed_cards);

delete from public.appointments where client_id in (select id from removed_cards);

delete from public.clients where id in (select id from removed_cards);

commit;

select (select count(*) from public.audit_events where source = 'release_2026_10_21_guest_visits') as cards_removed,
       (select coalesce(sum(jsonb_array_length(metadata -> 'bookings')), 0) from public.audit_events
         where source = 'release_2026_10_21_guest_visits') as bookings_removed,
       (select count(*) from public.sales where is_guest) as guest_visits,
       (select count(*) from public.clients) as clients_left,
       (select count(*) from public.clients where first_name is null) as cards_without_parts,
       (select count(*) from public.clients where phone_e164 is null) as cards_without_number;
