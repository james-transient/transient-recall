# Transient Recall API (TR)

Deterministic MCP service for workflow continuity across AI sessions and tools.

This repository is the AGPL-licensed public source repository for Transient Recall.

## License

This project is licensed under GNU Affero General Public License v3.0. See `LICENSE`.

- SPDX identifier for new files: `AGPL-3.0-only`
- If you run a modified version for users over a network, you must provide corresponding source to those users (AGPL section 13).

## Commercial Licensing

AGPL remains the default public license. If you need alternative commercial terms (for example, embedding or distribution models that are incompatible with AGPL obligations), contact: `licensing@transientintelligence.com`.

## Why TR

- Workflow continuity over generic memory: checkpointed state transitions, not only semantic retrieval.
- Deterministic and auditable: append-only events + explicit graph lineage + graph diffs.
- Git-aware by default: commit boundaries, historical import, and branch-aware context.
- Local-first and self-hostable: run fully on your machine with Docker/npm.
- MCP-native automation: reusable tools for decisioning and packet shaping.

## Quick Start

### Option A: Docker

```bash
cp docker.env.example docker.env
docker compose --env-file docker.env up -d
```

Health check:

```bash
curl http://localhost:8090/healthz
```

### Option B: Source setup

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

## MCP Endpoints

- Streamable HTTP: `http://localhost:8090/mcp`
- SSE: `http://localhost:8090/sse`
- Messages: `http://localhost:8090/messages`

## Core Tools

- `tr_checkpoint`
- `tr_resume`
- `tr_status`
- `tr_timeline`
- `tr_projects`
- `tr_search_checkpoints`
- `tr_blockers`
- `tr_graph_view`
- `tr_graph_diff`

## Public Mirror Notes

- This repo intentionally excludes secrets and internal-only operational material.
- Do not commit `.env`, credentials, private keys, or internal infrastructure identifiers.

## Related Project

- Transient Intelligence (TI) docs: [github.com/james-transient/transient-intelligence](https://github.com/james-transient/transient-intelligence)
