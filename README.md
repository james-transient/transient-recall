# Solving AI Amnesia: TR

Transient Recall (TR) is a self-hosted context continuity layer for AI coding and knowledge workflows. It preserves project memory across sessions so agents can resume with consistent context.

## What This Repository Includes

- Public installation and setup guidance
- MCP connection and workflow patterns
- Troubleshooting and operational notes

## Why TR

- Maintains continuity across AI sessions
- Reduces repeated onboarding and context loss
- Supports multi-client MCP integration for developer workflows

## Install (Artifact-Friendly)

Use your preferred installation path to run TR locally (Docker-based recommended). Ensure the TR MCP endpoint is reachable from your AI client, for example:

```text
http://localhost:8090/mcp
```

## MCP Configuration Pattern

Recommended server entry shape:

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

## Daily Workflow (Minimal)

1. Start your AI session and call status/resume.
2. Work normally.
3. Save key milestones with checkpoints.
4. On next session, resume from timeline/context.

## Troubleshooting

- **No data on resume:** confirm `x-tr-project` matches the active project.
- **Connection refused:** verify TR is running and `url` points to the correct host port.
- **Unexpected context switch:** confirm `x-tr-subject` and tenant headers are stable.

## Public-Safe Scope

This repository contains public-safe setup and workflow guidance. It excludes private infrastructure details, secrets, and proprietary internals.

## Related Project

- Transient Intelligence (TI): [transient-intelligence](https://github.com/james-transient/transient-intelligence)
