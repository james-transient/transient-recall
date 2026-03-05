#!/usr/bin/env bash
# One-command public installer (artifact-only).
# Starts TR with pinned image tags and prints MCP config.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.artifact.yml"

TR_IMAGE="${TR_IMAGE:-ghcr.io/james-transient/transient-recall-api}"
TR_VERSION="${TR_VERSION:-v0.1.0}"
TR_PORT="${TR_PORT:-8090}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-tr}"
TR_STACK_NAME="${TR_STACK_NAME:-tr}"
TR_PROJECT="${TR_PROJECT:-$(basename "$PWD")}"
MCP_URL="http://localhost:${TR_PORT}/mcp"
TR_CONFIGURE_CURSOR="${TR_CONFIGURE_CURSOR:-1}"
TR_CONFIGURE_CURSOR_FORCE="${TR_CONFIGURE_CURSOR_FORCE:-0}"

echo "==> Transient Recall artifact install"
echo "    image: ${TR_IMAGE}:${TR_VERSION}"
echo ""

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Desktop/Engine and retry."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker and retry."
  exit 1
fi

if docker image inspect "${TR_IMAGE}:${TR_VERSION}" >/dev/null 2>&1; then
  echo "--> Using local image ${TR_IMAGE}:${TR_VERSION}"
else
  echo "--> Pulling pinned image..."
  if ! docker pull "${TR_IMAGE}:${TR_VERSION}"; then
    exit 1
  fi
fi

echo "--> Starting stack with Docker Compose..."
TR_IMAGE="$TR_IMAGE" \
TR_VERSION="$TR_VERSION" \
TR_PORT="$TR_PORT" \
POSTGRES_PORT="$POSTGRES_PORT" \
POSTGRES_USER="$POSTGRES_USER" \
POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
POSTGRES_DB="$POSTGRES_DB" \
docker compose -p "$TR_STACK_NAME" -f "$COMPOSE_FILE" up -d

echo "--> Waiting for health endpoint..."
for i in {1..45}; do
  if curl -sf "http://localhost:${TR_PORT}/healthz" >/dev/null 2>&1; then
    if [[ "$TR_CONFIGURE_CURSOR" == "1" ]] && command -v node >/dev/null 2>&1; then
      TR_PORT="$TR_PORT" TR_MCP_URL="$MCP_URL" TR_PROJECT="$TR_PROJECT" TR_CONFIGURE_CURSOR_FORCE="$TR_CONFIGURE_CURSOR_FORCE" \
        bash "$SCRIPT_DIR/sync-cursor-mcp.sh" >/dev/null 2>&1 || true
    fi
    cat <<EOF

==> TR is live
MCP URL: ${MCP_URL}
Health:  http://localhost:${TR_PORT}/healthz
Cursor MCP auto-sync: $( [[ "$TR_CONFIGURE_CURSOR" == "1" ]] && echo "enabled" || echo "disabled" )
Cursor MCP mode: $( [[ "$TR_CONFIGURE_CURSOR_FORCE" == "1" ]] && echo "force (reset headers/project)" || echo "safe (preserve existing headers/project)" )

Paste this into Cursor MCP settings:
{
  "mcpServers": {
    "transient-recall-local": {
      "url": "${MCP_URL}",
      "headers": {
        "x-tr-subject": "local-dev-user",
        "x-tr-tenant": "public",
        "x-tr-project": "${TR_PROJECT}"
      }
    }
  }
}

One place to paste: Cursor settings -> MCP configuration.

Then create this rule file in your workspace:
  .cursor/rules/tr-continuity.mdc

Paste this rule content:
---
description: Transient Recall - automatic resume and checkpoint for workflow continuity
alwaysApply: true
---

# TR Continuity (automatic)

**First action every conversation:** Call `tr_resume(project)` and `tr_status(project)` immediately. Use workspace folder name as project (for example `my-team-history` in shared repos). If `reminder_due` is true, call `tr_checkpoint` before doing anything else.

**Checkpoint automatically** — call `tr_checkpoint` when:
- You complete a task or reach a task boundary
- You make a significant decision
- You resolve or add a blocker
- You switch to a new goal or topic
- Before your final response, if you changed blockers/next_actions/decisions

**High-value payload contract for each checkpoint:**
- `current_goal`: one clear sentence of the objective now
- `context_capsule`: concise "what changed + why"
- `decision_rationale`: reason for the chosen approach
- `next_actions`: explicit next 1-3 actions
- `files_touched` and `code_refs`: include when code or files changed

**Session cadence (always):**
- Start: `tr_resume` + `tr_status`, then set/confirm current goal
- Mid-session: checkpoint at meaningful decision boundaries
- End-session: checkpoint with blockers and next actions before final response

**Do not skip:** Checkpoint before replying if state changed. Resume at session start. This is automatic workflow continuity.
EOF
    exit 0
  fi
  sleep 1
done

echo "TR did not become healthy in time."
echo "Inspect logs: docker compose -p \"$TR_STACK_NAME\" -f \"$COMPOSE_FILE\" logs tr-api"
exit 1
