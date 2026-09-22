-- Every morning at 10:00 Tashkent the marketing group gets a Telegram message
-- with yesterday's, this week's and this month's new clients. The message is
-- built and sent by the marketing-digest Edge Function; this schedule only
-- calls it. pg_cron keeps time in UTC and Uzbekistan has no daylight saving,
-- so 05:00 UTC is 10:00 local all year round.
--
-- The function checks a shared secret. It is not in this file: before the
-- first run it has to be stored in Vault under the name the job reads, with
-- the same value as the MARKETING_DIGEST_SECRET function secret:
--   select vault.create_secret('<value>', 'marketing_digest_secret');

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists pg_net with schema extensions;

-- cron.schedule with a name replaces the job of that name, so re-running this
-- file updates the schedule instead of adding a second one.
select cron.schedule(
  'maestro-marketing-digest',
  '0 5 * * *',
  $job$
  select net.http_post(
    url := 'https://ivowbhraaistxvoymxpf.supabase.co/functions/v1/marketing-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-marketing-digest-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'marketing_digest_secret')
    ),
    body := '{"action":"send"}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id;
  $job$
);
