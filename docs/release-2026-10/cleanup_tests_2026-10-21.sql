-- 2026-10-21, owner's request: the live tests of the clients' bot, the QR at
-- the mirror and the rating leave no trace. Gone: the test visit (1 000 сум,
-- Жавохир, waiting for approval), its rating «Увольте мастера», the QR scan,
-- and the test site booking of 17:49 (cancelled). Each is copied whole into
-- audit_events first (the visit also by its own delete trigger), so it can
-- be put back. The client's card stays: it is a real card from July that got
-- its surname at the QR.
begin;

insert into public.audit_events (entity_type, entity_id, operation, event_name, source, old_values, metadata)
select 'visit_review', review.id::text, 'delete', 'visit_review.deleted', 'cleanup_2026_10_21_tests', to_jsonb(review),
       jsonb_build_object('reason', 'live test')
  from public.visit_reviews as review where review.sale_id = 4476;

insert into public.audit_events (entity_type, entity_id, operation, event_name, source, old_values, metadata)
select 'client_scan', scan.id::text, 'delete', 'client_scan.deleted', 'cleanup_2026_10_21_tests', to_jsonb(scan),
       jsonb_build_object('reason', 'live test')
  from public.client_scans as scan where scan.id = 1;

insert into public.audit_events (entity_type, entity_id, operation, event_name, source, old_values, metadata)
select 'appointment', booking.id::text, 'delete', 'appointment.deleted', 'cleanup_2026_10_21_tests', to_jsonb(booking),
       jsonb_build_object(
         'reason', 'live test',
         'events', (select coalesce(jsonb_agg(to_jsonb(event)), '[]'::jsonb) from public.appointment_events as event where event.appointment_id = booking.id),
         'notices', (select coalesce(jsonb_agg(to_jsonb(notice)), '[]'::jsonb) from public.appointment_notification_deliveries as notice where notice.appointment_id = booking.id))
  from public.appointments as booking where booking.id = '9698efbd-9eac-42fe-8477-7821a782c38e';

delete from public.visit_reviews where sale_id = 4476;
delete from public.client_scans where id = 1;
delete from public.sales where id = 4476 and status = 'pending' and cash + card + qr = 1000;
delete from public.appointments where id = '9698efbd-9eac-42fe-8477-7821a782c38e' and status = 'cancelled';

commit;

select (select count(*) from public.audit_events where source = 'cleanup_2026_10_21_tests') as kept_in_journal,
       (select count(*) from public.audit_events where entity_type = 'sale' and entity_id = '4476') as visit_kept_by_trigger,
       (select count(*) from public.sales where id = 4476) as visit_left,
       (select count(*) from public.visit_reviews) as reviews_left,
       (select count(*) from public.client_scans) as scans_left,
       (select count(*) from public.appointments where id = '9698efbd-9eac-42fe-8477-7821a782c38e') as booking_left,
       (select count(*) from public.maestro_master_ratings()) as masters_rated;
