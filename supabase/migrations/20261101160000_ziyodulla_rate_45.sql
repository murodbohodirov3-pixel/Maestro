-- The owner's decision of 2026-11-01: from 2 November Зиёдулла (master 21)
-- earns 45% instead of 40%. The earlier rate covers every date before that,
-- matching every sale he already has (245 at 40%). The nightly
-- maestro-commission-sync job then sets masters.pct to the day's rate.
insert into public.master_commission_rates (master_id, pct, effective_from, note) values
  (21, 40, '2000-01-01', 'ставка до 02.11.2026'),
  (21, 45, '2026-11-02', 'решение владельца 01.11.2026')
on conflict (master_id, effective_from) do nothing;

select master_id, pct, effective_from from public.master_commission_rates where master_id = 21 order by effective_from;
