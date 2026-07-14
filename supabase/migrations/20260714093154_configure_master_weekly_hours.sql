do $$
declare
  matched_masters integer;
begin
  select count(*)
    into matched_masters
  from public.masters
  where active
    and name in ('Жавлон', 'Иброхим', 'Жамолиддин', 'Жавохир', 'Мироншох');

  if matched_masters <> 5 then
    raise exception 'Expected 5 active masters for calendar setup, found %', matched_masters;
  end if;

  delete from public.master_schedule_rules as rule
  using public.masters as master
  where rule.master_id = master.id
    and master.name in ('Жавлон', 'Иброхим', 'Жамолиддин', 'Жавохир', 'Мироншох');

  insert into public.master_schedule_rules (
    master_id,
    iso_weekday,
    starts_at,
    ends_at,
    active
  )
  select
    master.id,
    weekday.iso_weekday,
    configured.starts_at,
    configured.ends_at,
    true
  from (
    values
      ('Жавлон', time '10:00', time '22:00'),
      ('Иброхим', time '10:00', time '22:00'),
      ('Жамолиддин', time '09:00', time '23:00'),
      ('Жавохир', time '10:00', time '23:00'),
      ('Мироншох', time '10:00', time '23:00')
  ) as configured(master_name, starts_at, ends_at)
  join public.masters as master
    on master.name = configured.master_name
   and master.active
  cross join generate_series(1, 7) as weekday(iso_weekday);
end;
$$;
