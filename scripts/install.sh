#!/usr/bin/env bash
# One-click local installer for Transient Recall (TR).
# Run from repo root: ./scripts/install.sh  or  npm run install:local
#
# Options:
#   --configure-cursor    Add TR to ~/.cursor/mcp.json
#   --no-configure-cursor Skip MCP auto-sync for Cursor
#   --install-git-hook    Auto-checkpoint on key git workflow events
#   --power-mode          Start Power Mode daemon (opt-in)
#   --all                 Both of the above (maximum automation)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

export TR_PORT="${TR_PORT:-8090}"
MCP_URL="http://localhost:${TR_PORT}/mcp"

echo "==> Transient Recall – local install"
echo ""

# Check Docker
if ! command -v docker &>/dev/null; then
  echo "Docker is required. Install from https://docker.com or run:"
  echo "  brew install --cask docker"
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "Docker daemon is not running. Start Docker Desktop and retry."
  exit 1
fi

echo "--> Starting Postgres + TR API (Docker)..."
# Remove macOS ._* files that can break build on external volumes
find . -name '._*' -delete 2>/dev/null || true

if ! docker compose up -d --build 2>&1; then
  docker-compose up -d --build 2>&1 || {
    echo ""
    echo "Failed to start. If port ${TR_PORT} is in use, try: TR_PORT=8092 ./scripts/install.sh"
    exit 1
  }
fi

echo ""
echo "--> Waiting for TR API to be ready..."
for i in {1..30}; do
  if curl -sf "http://localhost:${TR_PORT}/healthz" &>/dev/null; then
    echo ""
    echo "==> TR is running locally"
    echo ""
    echo "  MCP endpoint: $MCP_URL"
    echo "  Health:       http://localhost:${TR_PORT}/healthz"
    echo ""
    echo "Add to Cursor MCP config (~/.cursor/mcp.json or .cursor/mcp.json):"
    echo ""
    echo '  "mcpServers": {'
    echo '    "transient-recall-local": {'
    echo "      \"url\": \"$MCP_URL\","
    echo '      "headers": {'
    echo '        "x-tr-subject": "local-dev-user",'
    echo '        "x-tr-tenant": "public"'
    echo '      }'
    echo '    }'
    echo '  }'
    echo ""
    echo "Then reload Cursor MCP servers. All data stays on your machine."
    echo ""

    # Optional: install git hooks for workflow auto-checkpoints
    INSTALL_HOOK=false
    [[ "$*" == *"--install-git-hook"* ]] && INSTALL_HOOK=true
    [[ "$*" == *"--all"* ]] && INSTALL_HOOK=true
    if [[ "$INSTALL_HOOK" == "true" ]]; then
      if [[ -d "$REPO_ROOT/.git" ]] && [[ -f "$SCRIPT_DIR/setup-git-hook.sh" ]]; then
        bash "$SCRIPT_DIR/setup-git-hook.sh" && echo "Git hooks installed: checkpoints run on pre/post commit, merge, checkout, and push."
      else
        echo "Skipping git hook (not a git repo or script missing)."
      fi
    fi

    # Auto-sync Cursor MCP by default; allow explicit opt-out.
    CONFIGURE_CURSOR=true
    [[ "$*" == *"--no-configure-cursor"* ]] && CONFIGURE_CURSOR=false
    [[ "$*" == *"--configure-cursor"* ]] && CONFIGURE_CURSOR=true
    [[ "$*" == *"--all"* ]] && CONFIGURE_CURSOR=true
    if [[ "$CONFIGURE_CURSOR" == "true" ]]; then
      if command -v node &>/dev/null; then
        TR_PORT="$TR_PORT" TR_MCP_URL="$MCP_URL" TR_PROJECT="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "$REPO_ROOT")")" TR_CONFIGURE_CURSOR_FORCE="${TR_CONFIGURE_CURSOR_FORCE:-0}" \
          bash "$SCRIPT_DIR/sync-cursor-mcp.sh" 2>/dev/null && \
          echo "Cursor MCP config synced (global + workspace). Reload MCP servers in Cursor." || \
          echo "Could not auto-sync Cursor MCP config. Add the snippet above manually."
      else
        echo "Node not found; add the MCP snippet above manually."
      fi
    fi

    # Optional: start power mode daemon (opt-in)
    POWER_MODE=false
    [[ "$*" == *"--power-mode"* ]] && POWER_MODE=true
    [[ "$*" == *"--all"* ]] && POWER_MODE=true
    if [[ "$POWER_MODE" == "true" ]]; then
      if [[ -f "$SCRIPT_DIR/power-mode.sh" ]]; then
        bash "$SCRIPT_DIR/power-mode.sh" start || true
      fi
    fi
    echo ""
    exit 0
  fi
  sleep 1
done

echo "TR API did not become ready in time. Check: docker compose logs tr-api"
exit 1
