-- The browser accesses these operational tables only through the api Edge
-- Function. Keep RLS enabled and do not create public-table policies here.
alter table public.app_users enable row level security;
alter table public.masters enable row level security;
alter table public.sales enable row level security;
alter table public.attendance enable row level security;
alter table public.fines enable row level security;
alter table public.expenses enable row level security;
alter table public.debts enable row level security;
alter table public.debt_payments enable row level security;
alter table public.settings enable row level security;
