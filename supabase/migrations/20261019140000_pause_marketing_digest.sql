-- The owner stopped the morning digest of new clients to the marketers' group
-- «Maestro Marketing» on 2026-10-19. The job is paused, not removed; to turn it
-- back on: cron.alter_job(<its jobid>, active := true).

select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'maestro-marketing-digest'),
  active := false
);
