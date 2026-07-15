create index if not exists clients_created_by_user_idx
  on public.clients (created_by_user_id)
  where created_by_user_id is not null;

create index if not exists clients_updated_by_user_idx
  on public.clients (updated_by_user_id)
  where updated_by_user_id is not null;

create index if not exists client_consent_events_actor_user_idx
  on public.client_consent_events (actor_user_id)
  where actor_user_id is not null;

create index if not exists client_events_actor_user_idx
  on public.client_events (actor_user_id)
  where actor_user_id is not null;
