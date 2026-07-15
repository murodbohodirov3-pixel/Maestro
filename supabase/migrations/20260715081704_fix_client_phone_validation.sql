alter table public.clients
  drop constraint clients_phone_e164_check,
  add constraint clients_phone_e164_check check (phone_e164 ~ '^[+][1-9][0-9]{6,14}$');

create or replace function public.maestro_normalize_phone(p_phone text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  with normalized as (
    select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits
  )
  select case
    when length(digits) = 9 then '+998' || digits
    when length(digits) between 7 and 15 then '+' || digits
    else null
  end
  from normalized;
$$;
