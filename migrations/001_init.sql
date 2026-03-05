create extension if not exists pgcrypto;

create table if not exists tr_events (
  id uuid primary key default gen_random_uuid(),
  tenant text not null,
  subject text not null,
  project text not null,
  event_type text not null,
  event_seq bigint not null,
  payload jsonb not null,
  payload_hash text not null,
  source text not null default 'mcp',
  created_at timestamptz not null default now()
);

create unique index if not exists tr_events_scope_seq_uq
  on tr_events (tenant, subject, project, event_seq);

create index if not exists tr_events_scope_created_idx
  on tr_events (tenant, subject, project, created_at desc);

create index if not exists tr_events_scope_payload_hash_idx
  on tr_events (tenant, subject, project, payload_hash);

create table if not exists tr_project_state (
  tenant text not null,
  subject text not null,
  project text not null,
  latest_event_id uuid not null references tr_events(id),
  latest_checkpoint jsonb not null,
  open_blockers jsonb not null default '[]'::jsonb,
  next_actions jsonb not null default '[]'::jsonb,
  momentum_score numeric not null default 0,
  last_checkpoint_at timestamptz not null,
  last_activity_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (tenant, subject, project)
);
