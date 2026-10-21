-- A guest without a name (owner's decision of 2026-10-21): a client who will
-- give neither his name nor his number. Since 2026-10-16 every visit had a
-- card, so masters made cards like «Klent» and «Клиент отказался». Now such a
-- visit has no card at all: each guest is a visit of his own, never one card
-- shared by all of them, and he is not in the client search. Whether he is
-- new or has been coming is still asked, and the owner hears of every guest.
-- A card, in turn, always has a number: a client who refuses it is a guest.

alter table public.sales
  add column if not exists is_guest boolean not null default false;

alter table public.sales
  drop constraint if exists sales_guest_has_no_card,
  add constraint sales_guest_has_no_card check (not is_guest or client_id is null);
