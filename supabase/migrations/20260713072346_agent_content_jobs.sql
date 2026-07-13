create table if not exists public.agent_content_jobs (
  id bigint generated always as identity primary key,
  owner_telegram_id text not null,
  kind text not null default 'reel',
  status text not null default 'draft',
  topic text not null,
  goal text not null,
  concept text not null,
  hook text not null,
  shot_list jsonb not null default '[]'::jsonb,
  voiceover text not null default '',
  on_screen_text jsonb not null default '[]'::jsonb,
  higgsfield_prompt text not null,
  negative_prompt text not null default '',
  cover_text text not null default '',
  caption text not null default '',
  cta text not null default '',
  stories jsonb not null default '[]'::jsonb,
  kpi text not null default '',
  provider text not null default 'higgsfield',
  provider_job_id text,
  result_url text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint agent_content_jobs_kind_check
    check (kind in ('reel', 'post', 'carousel', 'stories')),
  constraint agent_content_jobs_status_check
    check (status in ('draft', 'approved', 'generating', 'completed', 'failed', 'cancelled')),
  constraint agent_content_jobs_provider_check
    check (provider = 'higgsfield'),
  constraint agent_content_jobs_shot_list_check
    check (jsonb_typeof(shot_list) = 'array'),
  constraint agent_content_jobs_on_screen_text_check
    check (jsonb_typeof(on_screen_text) = 'array'),
  constraint agent_content_jobs_stories_check
    check (jsonb_typeof(stories) = 'array'),
  constraint agent_content_jobs_metadata_check
    check (jsonb_typeof(metadata) = 'object')
);

create index if not exists agent_content_jobs_owner_created_idx
  on public.agent_content_jobs (owner_telegram_id, created_at desc);

create index if not exists agent_content_jobs_status_updated_idx
  on public.agent_content_jobs (status, updated_at)
  where status in ('approved', 'generating');

alter table public.agent_content_jobs enable row level security;
alter table public.agent_content_jobs force row level security;

revoke all on table public.agent_content_jobs from anon, authenticated;
revoke all on sequence public.agent_content_jobs_id_seq from anon, authenticated;
grant all on table public.agent_content_jobs to service_role;
grant usage, select on sequence public.agent_content_jobs_id_seq to service_role;
