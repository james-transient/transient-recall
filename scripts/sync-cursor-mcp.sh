#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TR_PORT="${TR_PORT:-8090}"
MCP_URL="${TR_MCP_URL:-http://localhost:${TR_PORT}/mcp}"
PROJECT="${TR_PROJECT:-$(basename "$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null || echo "$REPO_ROOT")")}"
FORCE="${TR_CONFIGURE_CURSOR_FORCE:-0}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node is required to sync Cursor MCP config."
  exit 1
fi

GLOBAL_MCP="$HOME/.cursor/mcp.json"
WORKSPACE_MCP="$REPO_ROOT/.cursor/mcp.json"

mkdir -p "$(dirname "$GLOBAL_MCP")"
mkdir -p "$(dirname "$WORKSPACE_MCP")"

if [[ "$FORCE" == "1" ]]; then
  node "$SCRIPT_DIR/configure-cursor-mcp.mjs" "$GLOBAL_MCP" "$MCP_URL" "$PROJECT" --force
  node "$SCRIPT_DIR/configure-cursor-mcp.mjs" "$WORKSPACE_MCP" "$MCP_URL" "$PROJECT" --force
else
  node "$SCRIPT_DIR/configure-cursor-mcp.mjs" "$GLOBAL_MCP" "$MCP_URL" "$PROJECT"
  node "$SCRIPT_DIR/configure-cursor-mcp.mjs" "$WORKSPACE_MCP" "$MCP_URL" "$PROJECT"
fi

echo ""
echo "Synced Cursor MCP config:"
echo "  - $GLOBAL_MCP"
echo "  - $WORKSPACE_MCP"
echo "  URL: $MCP_URL"
echo "  Mode: $( [[ "$FORCE" == "1" ]] && echo "force" || echo "safe" )"

