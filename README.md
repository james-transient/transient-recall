# Solving AI Amnesia: TR

Transient Recall (TR) is a self-hosted context continuity layer for AI coding and knowledge workflows. It preserves project memory across sessions so agents can resume with consistent context.

## Website

- [Docs (TR setup & workflow)](https://transientintelligence.com/docs/transient-recall)

## Why TR

- Maintains continuity across AI sessions
- Reduces repeated onboarding and context loss
- Supports multi-client MCP integration for developer workflows

## Install

```bash
bash <(curl -fsSL https://transientintelligence.com/install/recall)
```

This installs TR + Postgres, applies migrations, and provides MCP/rule snippets for continuity setup.

## Verify service

```text
curl http://localhost:8090/healthz
# {"status":"ok"}
```

If you use a custom host port (for example `TR_PORT=8092`), use that same port in your MCP URL.

## MCP configuration

```json
{
  "mcpServers": {
    "transient-recall-local": {
      "url": "http://localhost:8090/mcp",
      "headers": {
        "x-tr-subject": "local-dev-user",
        "x-tr-tenant": "public",
        "x-tr-project": "my-project"
      }
    }
  }
}
```

Identity stability matters:

- Keep `x-tr-project` stable across sessions.
- Keep the tuple `x-tr-tenant`, `x-tr-subject`, `x-tr-project` unchanged to restore the same continuity stream.

## Daily workflow

1. Session start: call `tr_resume(project)` and `tr_status(project)`.
2. During work: checkpoint on task boundaries and major decisions.
3. Session end: checkpoint blockers and next actions.

Minimal checkpoint payload fields:

- `current_goal`
- `context_capsule`
- `decision_rationale`
- `next_actions`
- `files_touched` (when code changes)

## Core MCP tools

- `tr_checkpoint`
- `tr_resume`
- `tr_status`
- `tr_timeline`
- `tr_projects`
- `tr_search_checkpoints`
- `tr_blockers`
- `tr_graph_view`
- `tr_graph_diff`

## Repository continuity options

- Live continuity: ongoing `tr_checkpoint` calls via your AI client
- Historical indexing: backfill existing git history into the same project stream

## Troubleshooting

- **TR tools not visible:** reload MCP servers and verify URL/port.
- **Port conflict:** run install with `TR_PORT=<custom_port>` and align MCP URL.
- **Empty resume:** confirm identity tuple matches previous sessions.
- **Missing index after reinstall:** ensure you are connected to the same Postgres volume/stack.

## Guides

- [Install and verify](docs/install-verify.md)
- [Daily workflow](docs/daily-workflow.md)
- [Troubleshooting](docs/troubleshooting.md)

## Public-Safe Scope

This repository contains public-safe setup and workflow guidance. It excludes private infrastructure details, secrets, and proprietary internals.

## Related Project

- Transient Intelligence (TI): [transient-intelligence](https://github.com/james-transient/transient-intelligence)
