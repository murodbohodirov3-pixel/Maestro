-- The four trigger functions that fill in sales, fines and attendance rows
-- were executable by anyone holding the public key. They cannot do anything
-- when called outside a trigger, but nothing outside the server needs them:
-- only the server's role keeps them (security review of 2026-10-17).
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.attendance_fill_new_fields()',
    'public.fines_fill_new_fields()',
    'public.sales_fill_new_fields()',
    'public.sales_set_commission_pct()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
