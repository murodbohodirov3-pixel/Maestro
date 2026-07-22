-- Supabase default privileges grant service_role broad access to new public
-- tables. Keep the audit ledger append-only for the application role.
revoke update, delete, truncate, references, trigger
  on table public.audit_events
  from service_role;
