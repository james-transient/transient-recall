# Backup and restore (Postgres continuity)

This runbook documents how to export and restore Transient Recall continuity data.

## Scope

- Database: PostgreSQL backing TR (`tr_events`, `tr_project_state`, `tr_nodes`, `tr_edges`).
- Goal: preserve durable continuity state across machine migration, upgrades, and incident recovery.

## 1) Backup (Docker local)

Create a compressed dump from the running Postgres container:

```bash
docker exec -t tr-postgres pg_dump -U postgres -d tr -Fc > tr-backup-$(date +%Y%m%d-%H%M%S).dump
```

Recommended: keep at least daily backups and one weekly long-retention snapshot.

## 2) Restore (Docker local)

1. Ensure target Postgres is running and reachable.
2. Drop and recreate target DB (only for full restore targets):

```bash
docker exec -it tr-postgres psql -U postgres -c "DROP DATABASE IF EXISTS tr;"
docker exec -it tr-postgres psql -U postgres -c "CREATE DATABASE tr;"
```

3. Restore backup:

```bash
cat tr-backup-YYYYMMDD-HHMMSS.dump | docker exec -i tr-postgres pg_restore -U postgres -d tr --clean --if-exists
```

## 3) Backup/restore (managed Postgres)

Backup:

```bash
pg_dump "$DATABASE_URL" -Fc > tr-backup-$(date +%Y%m%d-%H%M%S).dump
```

Restore:

```bash
pg_restore --clean --if-exists -d "$DATABASE_URL" tr-backup-YYYYMMDD-HHMMSS.dump
```

## 4) Restore verification checklist

After restore, verify continuity state using the MCP smoke flow:

```bash
npm run smoke
```

Minimum pass criteria:

- `tr_status` returns healthy DB/system status.
- `tr_resume` returns expected context for known project(s).
- `tr_graph_diff` returns valid change payload for a test checkpoint cycle.
- Event and graph counts are non-zero for previously active projects.

## 5) Operational safeguards

- Test restore monthly (do not rely on untested backups).
- Keep backups encrypted at rest and in transit.
- Restrict backup file access to operators only.
- Never commit backup artifacts to git.
