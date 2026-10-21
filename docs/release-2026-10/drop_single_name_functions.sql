-- After the api with the two name parts is out (20261021120000_client_name_parts.sql):
-- the versions that took one full name are no longer called by anything.
drop function if exists public.maestro_add_client_card(text, text, boolean, bigint);
drop function if exists public.maestro_update_client_card(uuid, text, text, bigint);

select p.oid::regprocedure as left_over
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('maestro_add_client_card', 'maestro_update_client_card');
