# TR Install and Verify

Fast install path with concrete checks for MCP and continuity. Full docs: [transientintelligence.com/docs/transient-recall](https://transientintelligence.com/docs/transient-recall)

## 1) Install

```bash
bash <(curl -fsSL https://transientintelligence.com/install/recall)
```

This starts TR + Postgres, applies migrations, and prints MCP config snippets.

## 2) Verify service health

```bash
curl http://localhost:8090/healthz
```

If you changed ports, replace `8090` with your configured `TR_PORT`.

## 3) Verify MCP tools

In your MCP-capable client, reload MCP servers and run:

```text
Call tr_status for project: my-project
```

If `tr_status` returns data, MCP wiring is active.

## 4) Verify project continuity

1. Run one `tr_checkpoint` with your current goal.
2. Run `tr_resume` with the same project key.
3. Confirm the latest checkpoint appears in the returned context.

Keep `x-tr-project` stable to avoid continuity drift.
