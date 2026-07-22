-- CREATE OR REPLACE VIEW resets reloptions on the existing production view.
-- Keep the CRM export subject to the caller's RLS context.
alter view public.client_export set (security_invoker = true);
