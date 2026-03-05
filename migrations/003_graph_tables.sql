create table if not exists tr_nodes (
  id uuid primary key default gen_random_uuid(),
  tenant text not null,
  subject text not null,
  project text not null,
  node_type text not null,
  node_key text not null,
  props jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz null
);

create unique index if not exists tr_nodes_scope_key_uq
  on tr_nodes (tenant, subject, project, node_type, node_key);

create index if not exists tr_nodes_scope_idx
  on tr_nodes (tenant, subject, project);

create table if not exists tr_edges (
  id uuid primary key default gen_random_uuid(),
  tenant text not null,
  subject text not null,
  project text not null,
  from_node_id uuid not null references tr_nodes(id) on delete cascade,
  to_node_id uuid not null references tr_nodes(id) on delete cascade,
  edge_type text not null,
  props jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz null
);

create unique index if not exists tr_edges_scope_unique_uq
  on tr_edges (tenant, subject, project, from_node_id, to_node_id, edge_type);

create index if not exists tr_edges_scope_idx
  on tr_edges (tenant, subject, project);
