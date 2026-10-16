-- After the seven migrations of the October 2026 release: every row true.
select jsonb_build_object(
  'online_booking', exists (select 1 from pg_proc where proname = 'maestro_hold_booking'),
  'client_visits', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sales' and column_name = 'client_id'),
  'bookings_in_app', exists (select 1 from pg_proc where proname = 'maestro_book_appointment'),
  'partner_outcomes', position('''partner''' in pg_get_functiondef('public.maestro_set_appointment_outcome(uuid, text, text, text, text, bigint)'::regprocedure)) > 0,
  'auto_fines', (select late_fine_amount = 100000 and no_mark_fine_amount = 100000 and auto_fines_since is not null and booking_control_since is not null from public.settings where id = 1),
  'booking_moves', exists (select 1 from pg_proc where proname = 'maestro_move_appointment'),
  'payouts', exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'master_payouts'),
  'user_language', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_users' and column_name = 'lang'),
  'cron_jobs', (select count(*) = 3 from cron.job where jobname in ('maestro-booking-holds', 'maestro-booking-reminders', 'maestro-no-mark-fines')),
  'vault_cron_secret', exists (select 1 from vault.secrets where name = 'booking_cron_secret'),
  'history', (select count(*) = 7 from supabase_migrations.schema_migrations where version >= '20261015120000'),
  'nothing_for_anon', not exists (
    select 1 from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'maestro_%' and has_function_privilege('anon', p.oid, 'execute')
      and p.proname in ('maestro_hold_booking', 'maestro_book_appointment', 'maestro_move_appointment', 'maestro_settle_late_fine', 'maestro_delete_advance', 'maestro_convert_fine_to_advance')
  )
) as checks;
