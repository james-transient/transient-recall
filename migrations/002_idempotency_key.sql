alter table tr_events
  add column if not exists idempotency_key text;

create unique index if not exists tr_events_scope_idempotency_uq
  on tr_events (tenant, subject, project, idempotency_key)
  where idempotency_key is not null;
