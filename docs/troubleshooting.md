# TR Troubleshooting

Fast fixes for the most common continuity issues: missing tools, empty resume, and project drift. Full docs: [transientintelligence.com/docs/transient-recall/troubleshooting](https://transientintelligence.com/docs/transient-recall/troubleshooting)

## TR tools not visible

- Reload MCP servers in your client.
- Verify MCP URL matches your running TR port (`8090` by default).
- Run health check:

```bash
curl http://localhost:8090/healthz
```

## Port already in use

Start TR on a different port and keep MCP URL aligned.

```bash
TR_PORT=8092 bash <(curl -fsSL https://transientintelligence.com/install/recall)
```

Update your MCP config URL to `http://localhost:8092/mcp`.

## Resume returns empty context

Usually a scope mismatch. Keep the identity tuple stable:

- `x-tr-tenant`
- `x-tr-subject`
- `x-tr-project`

If any of these change, TR treats it as a different continuity stream.

## Lost context after Docker restart

As long as you have not run `docker compose down -v`, your Postgres volume is intact. If resume still looks empty, verify you are using the exact same `x-tr-tenant`, `x-tr-subject`, and `x-tr-project` values as before restart.

## Index appears missing after reinstall

Check you are connected to the same TR Postgres volume/stack as before. A new stack name or fresh volume can create an empty database.

Quick check in AI client:

```
Call tr_status(project) and confirm checkpoint_count + last_checkpoint_at.
```
