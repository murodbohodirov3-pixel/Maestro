-- Owner's decision of 2026-10-16: the one «штраф-аванс» still standing —
-- Салим, 150 000, 15.10.2026 (fine 376, reason «Другое») — is an advance.
-- Run once, right after 20261016180000_payouts.sql. If the fine was deleted
-- or changed in the meantime, nothing happens. The fine's deletion lands in
-- the owner's deletion log, as done by the owner (app user 7).
do $$
declare
  fine public.fines;
begin
  select * into fine from public.fines
  where id = 376 and master_id = 24 and amount = 150000 and reason = 'other' and d = '2026-10-15';
  if not found then
    raise notice 'fine 376 is gone or changed: nothing moved';
    return;
  end if;
  insert into public.master_advances (master_id, master, amount, given_on, note, converted_from_fine_id, created_by_user_id)
  values (fine.master_id, fine.master, fine.amount, fine.d, 'из штрафа', fine.id, 7);
  perform public.maestro_prepare_delete_audit(7, 'fine_to_advance', gen_random_uuid());
  delete from public.fines where id = fine.id;
end;
$$;

select jsonb_build_object(
  'fine_376_left', (select count(*) from public.fines where id = 376),
  'advance', (select jsonb_build_object('master', master, 'amount', amount, 'given_on', given_on, 'from_fine', converted_from_fine_id)
              from public.master_advances where converted_from_fine_id = 376)
) as result;
