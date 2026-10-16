-- Weekly payouts and advances (owner's decisions of 2026-10-16).
--
-- A week runs Monday to Sunday and is paid on Sunday night. What a master is
-- owed for it is his commission on the week's counted visits, less the week's
-- fines, less the advances he took that week, less what was already paid for
-- it. An advance is part of his own earnings paid early: not a fine, not salon
-- income, it only lowers «к выплате». Until now the owner booked an advance as
-- a fine and deleted it after paying; the one such fine still standing at the
-- release is moved here by docs/release-2026-10/salim_advance.sql.
--
-- The figures are the app's (the same commission rule as everywhere); a
-- payout row keeps what the owner saw and paid, so a sale approved later shows
-- as still owed instead of rewriting a paid week.

create table if not exists public.master_advances (
  id bigint generated always as identity primary key,
  master_id bigint not null references public.masters (id) on delete restrict,
  master text not null,
  amount bigint not null check (amount > 0 and amount <= 100000000),
  given_on date not null,
  note text check (note is null or char_length(note) <= 200),
  converted_from_fine_id bigint,
  created_by_user_id bigint references public.app_users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists master_advances_week_idx on public.master_advances (master_id, given_on desc);

create table if not exists public.master_payouts (
  id bigint generated always as identity primary key,
  master_id bigint not null references public.masters (id) on delete restrict,
  master text not null,
  week_start date not null check (extract(isodow from week_start) = 1),
  amount bigint not null check (amount >= 0 and amount <= 1000000000),
  -- What the week looked like when it was paid.
  earned bigint not null default 0 check (earned >= 0),
  fines bigint not null default 0 check (fines >= 0),
  advances bigint not null default 0 check (advances >= 0),
  paid_by_user_id bigint references public.app_users (id) on delete set null,
  paid_at timestamptz not null default now()
);
create index if not exists master_payouts_week_idx on public.master_payouts (master_id, week_start desc);

alter table public.master_advances enable row level security;
alter table public.master_payouts enable row level security;
revoke all on public.master_advances, public.master_payouts from anon, authenticated;

-- Deletions land in the owner's deletion log like every other record.
drop trigger if exists audit_master_advances_delete on public.master_advances;
create trigger audit_master_advances_delete after delete on public.master_advances
  for each row execute function public.maestro_capture_delete_audit();
drop trigger if exists audit_master_payouts_delete on public.master_payouts;
create trigger audit_master_payouts_delete after delete on public.master_payouts
  for each row execute function public.maestro_capture_delete_audit();

create or replace function public.maestro_week_start(p_day date)
returns date
language sql
immutable
set search_path = ''
as $$
  select p_day - (extract(isodow from p_day)::integer - 1)
$$;

-- An advance taken back by mistake, while its week is still unpaid.
create or replace function public.maestro_delete_advance(
  p_id bigint,
  p_actor_user_id bigint,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  advance public.master_advances;
begin
  select * into advance from public.master_advances where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'advance_not_found'); end if;
  if exists (
    select 1 from public.master_payouts
    where master_id = advance.master_id and week_start = public.maestro_week_start(advance.given_on)
  ) then
    return jsonb_build_object('ok', false, 'error', 'advance_week_paid');
  end if;
  perform public.maestro_prepare_delete_audit(p_actor_user_id, 'web_app', p_correlation_id);
  delete from public.master_advances where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- A payout recorded by mistake, taken back within three days.
create or replace function public.maestro_delete_payout(
  p_id bigint,
  p_actor_user_id bigint,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  payout public.master_payouts;
begin
  select * into payout from public.master_payouts where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'payout_not_found'); end if;
  if payout.paid_at < now() - interval '3 days' then
    return jsonb_build_object('ok', false, 'error', 'payout_delete_window_expired');
  end if;
  perform public.maestro_prepare_delete_audit(p_actor_user_id, 'web_app', p_correlation_id);
  delete from public.master_payouts where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_week_start(date)',
    'public.maestro_delete_advance(bigint, bigint, uuid)',
    'public.maestro_delete_payout(bigint, bigint, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
