-- A co-founder's account: he reads the salon's figures and changes nothing.
-- The rules for the role live in the api (supabase/functions/_shared/access.js):
-- a partner may only load, and expenses reach him without names or notes.
-- Until the api knows the role, an account with it is refused as not_in_list.
alter table public.app_users drop constraint if exists app_users_role_check;
alter table public.app_users add constraint app_users_role_check
  check (role = any (array['owner', 'admin', 'master', 'finance', 'partner']));
