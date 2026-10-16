-- The October 2026 release's migrations, applied by hand with
-- `db query --linked -f`, written into the migration history afterwards.
insert into supabase_migrations.schema_migrations (version, name) values
  ('20261015120000', 'online_booking'),
  ('20261016100000', 'client_visits'),
  ('20261016120000', 'bookings_in_app'),
  ('20261016140000', 'auto_fines'),
  ('20261016160000', 'booking_moves'),
  ('20261016180000', 'payouts'),
  ('20261016200000', 'user_language')
on conflict (version) do nothing;

select version, name from supabase_migrations.schema_migrations
where version >= '20261015120000' order by version;
