# TR Troubleshooting

Fast fixes for missing tools, empty resume, and continuity drift. Full docs: [transientintelligence.com/docs/transient-recall/troubleshooting](https://transientintelligence.com/docs/transient-recall/troubleshooting)

## TR tools not visible

- Reload MCP servers in your client.
- Verify MCP URL matches your running TR host port.
- Run health check:

```bash
curl http://localhost:8090/healthz
```

## Port already in use

Start TR on a different port and keep MCP URL aligned.

```bash
TR_PORT=8092 bash <(curl -fsSL https://transientintelligence.com/install/recall)
```

## Resume returns empty context

Keep this identity tuple stable:

- `x-tr-tenant`
- `x-tr-subject`
- `x-tr-project`

If any value changes, TR treats it as a different continuity stream.

## Index appears missing after reinstall

Confirm you are connected to the same TR Postgres volume/stack as before. A new stack name or fresh volume creates an empty database.

Quick AI-side check:

```text
Call tr_status(project) and confirm checkpoint_count + last_checkpoint_at.
```
