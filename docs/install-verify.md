# TR Install and Verify

Fast install path with concrete checks to confirm MCP connectivity and project-scoped continuity. Full docs: [transientintelligence.com/docs/transient-recall](https://transientintelligence.com/docs/transient-recall)

## 1) Install

```bash
bash <(curl -fsSL https://transientintelligence.com/install/recall)
```

This starts TR + Postgres, applies migrations, and prints MCP config/rule snippets.

## 2) Configure your MCP client

Use the printed MCP config in your client settings, then reload MCP servers. Cursor: `.cursor/mcp.json` in workspace root, or `~/.cursor/mcp.json` for global. Example:

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

Set `x-tr-project` to your repo or project name. Keep it stable across restarts — continuity restore depends on the exact identity tuple: `x-tr-tenant`, `x-tr-subject`, and `x-tr-project`.

## 3) Add continuity instructions

Paste the block below into your coding agent (Cursor, Copilot, Windsurf, Claude, etc.). The agent will create rule files in `.cursor/rules/` (or your tool's equivalent rules path). This ensures your AI resumes at session start and checkpoints with git metadata.

```
[INSTALL TR RULES] Create these two files in the workspace root. Path: .cursor/rules/ (or your IDE's equivalent rules directory).

FILE 1: .cursor/rules/tr-continuity.mdc
---
description: Transient Recall - automatic resume and checkpoint for workflow continuity
alwaysApply: true
---

# TR Continuity (automatic)

**First action every conversation:** Call tr_resume(project) and tr_status(project) immediately. Use workspace folder name as project (e.g. my-team-history in shared repos). If reminder_due is true, call tr_checkpoint before doing anything else.

**Checkpoint automatically** — call tr_checkpoint when:
- You complete a task or reach a task boundary
- You make a significant decision
- You resolve or add a blocker
- You switch to a new goal or topic
- Before your final response, if you changed blockers/next_actions/decisions

**High-value payload contract for each checkpoint:**
- current_goal: one clear sentence of the objective now
- context_capsule: concise "what changed + why"
- decision_rationale: reason for the chosen approach
- next_actions: explicit next 1-3 actions
- files_touched and code_refs: include when code or files changed

**Session cadence (always):**
- Start: tr_resume + tr_status, then set/confirm current goal
- Mid-session: checkpoint at meaningful decision boundaries
- End-session: checkpoint with blockers and next actions before final response

**Do not skip:** Checkpoint before replying if state changed. Resume at session start.

---

FILE 2: .cursor/rules/tr-checkpoint-git-enrich.mdc
---
description: Enrich TR checkpoints with git state (commit_sha, branch, files_touched)
alwaysApply: true
---

# TR Checkpoint Git Enrichment

When calling tr_checkpoint, always run git in the workspace first and pass results into the work_packet. TR runs in Docker and cannot access your filesystem — enrichment is client-side only.

Before checkpointing, run in the workspace root:
  git rev-parse --short HEAD
  git rev-parse --abbrev-ref HEAD
  git log -1 --pretty=%s
  git diff --cached --name-only; git diff --name-only

Pass into work_packet:
- commit_sha: output of git rev-parse --short HEAD
- commit_subject: output of git log -1 --pretty=%s
- files_touched: combined staged + unstaged file names, capped at ~60
- Include branch in context_capsule if useful
```

## 4) Verify service health

```bash
curl http://localhost:8090/healthz
```

Expect `{"status":"ok"}`. If you changed ports, replace `8090` with your `TR_PORT`.

## 5) Verify MCP tools are visible

In your MCP-capable client, reload MCP servers and run:

```
Call tr_status for project: my-project
```

If `tr_status` responds, MCP wiring is active.

## 6) Verify project continuity

1. Run one checkpoint: `tr_checkpoint` with your current goal.
2. Run `tr_resume` with the same project key.
3. Confirm the latest checkpoint appears in the returned context pack.

Keep `x-tr-project` stable across restarts to avoid continuity drift.

## Optional: Historical indexing (backfill)

To backfill past commits into the same project stream, run from your repo directory:

```bash
docker run --rm \
  -v "${PWD}:/repo" \
  -e TR_MCP_BASE_URL="http://host.docker.internal:8090" \
  ghcr.io/james-transient/transient-recall-api:v0.1.0 \
  node scripts/backfill-commits.mjs \
    --project="my-team-history" \
    --all_history=true \
    --idempotency_scope=repo \
    --repo_root="/repo"
```

On Linux, add `--add-host=host.docker.internal:host-gateway` if `host.docker.internal` is unavailable.
