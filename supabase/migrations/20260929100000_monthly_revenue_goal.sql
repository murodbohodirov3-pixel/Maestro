-- The owner's revenue target for the month, shown on Обзор against the month's
-- forecast. One standing figure: it applies to whichever month is current
-- until the owner changes it. Written only through the `api` setSettings
-- allowlist; RLS on `settings` is unchanged.
alter table public.settings
  add column if not exists monthly_revenue_goal bigint
  constraint settings_monthly_revenue_goal_range
  check (monthly_revenue_goal is null or monthly_revenue_goal between 0 and 100000000000);
