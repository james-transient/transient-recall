#!/usr/bin/env bash
# Install git hooks to auto-checkpoint on key workflow boundaries.
# Run from repo root. Project is inferred from repo name.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

GIT_DIR="$(git rev-parse --git-dir 2>/dev/null)" || { echo "Not a git repo."; exit 1; }
PROJECT="$(basename "$(git rev-parse --show-toplevel)")"
HOOKS_DIR="$GIT_DIR/hooks"

mkdir -p "$HOOKS_DIR"

append_tr_block() {
  local hook_path="$1"
  local block="$2"

  if [[ ! -f "$hook_path" ]]; then
    cat > "$hook_path" << 'SHEBANG'
#!/usr/bin/env bash
SHEBANG
  fi

  if ! grep -q "BEGIN_TRANSIENT_RECALL_AUTO_CHECKPOINT" "$hook_path"; then
    printf "\n%s\n" "$block" >> "$hook_path"
  fi

  chmod +x "$hook_path"
}

POST_COMMIT_BLOCK=$(cat << 'EOF'
# BEGIN_TRANSIENT_RECALL_AUTO_CHECKPOINT
cd "$(git rev-parse --show-toplevel)"
export TR_MCP_BASE_URL="${TR_MCP_BASE_URL:-http://localhost:8090}"
npm run checkpoint:commit -- --trigger=post-commit --phase=post --project="$(basename "$PWD")" 2>/dev/null || true
# END_TRANSIENT_RECALL_AUTO_CHECKPOINT
EOF
)

PRE_COMMIT_BLOCK=$(cat << 'EOF'
# BEGIN_TRANSIENT_RECALL_AUTO_CHECKPOINT
cd "$(git rev-parse --show-toplevel)"
export TR_MCP_BASE_URL="${TR_MCP_BASE_URL:-http://localhost:8090}"
npm run checkpoint:commit -- --trigger=pre-commit --phase=pre --project="$(basename "$PWD")" 2>/dev/null || true
# END_TRANSIENT_RECALL_AUTO_CHECKPOINT
EOF
)

POST_MERGE_BLOCK=$(cat << 'EOF'
# BEGIN_TRANSIENT_RECALL_AUTO_CHECKPOINT
cd "$(git rev-parse --show-toplevel)"
export TR_MCP_BASE_URL="${TR_MCP_BASE_URL:-http://localhost:8090}"
npm run checkpoint:commit -- --trigger=post-merge --phase=post --project="$(basename "$PWD")" 2>/dev/null || true
# END_TRANSIENT_RECALL_AUTO_CHECKPOINT
EOF
)

POST_CHECKOUT_BLOCK=$(cat << 'EOF'
# BEGIN_TRANSIENT_RECALL_AUTO_CHECKPOINT
cd "$(git rev-parse --show-toplevel)"
export TR_MCP_BASE_URL="${TR_MCP_BASE_URL:-http://localhost:8090}"
npm run checkpoint:commit -- --trigger=post-checkout --phase=post --project="$(basename "$PWD")" --checkout_from="$1" --checkout_to="$2" --checkout_is_branch="$3" 2>/dev/null || true
# END_TRANSIENT_RECALL_AUTO_CHECKPOINT
EOF
)

PRE_PUSH_BLOCK=$(cat << 'EOF'
# BEGIN_TRANSIENT_RECALL_AUTO_CHECKPOINT
cd "$(git rev-parse --show-toplevel)"
export TR_MCP_BASE_URL="${TR_MCP_BASE_URL:-http://localhost:8090}"
npm run checkpoint:commit -- --trigger=pre-push --phase=post --project="$(basename "$PWD")" --push_remote="$1" --push_url="$2" 2>/dev/null || true
# END_TRANSIENT_RECALL_AUTO_CHECKPOINT
EOF
)

append_tr_block "$HOOKS_DIR/post-commit" "$POST_COMMIT_BLOCK"
append_tr_block "$HOOKS_DIR/pre-commit" "$PRE_COMMIT_BLOCK"
append_tr_block "$HOOKS_DIR/post-merge" "$POST_MERGE_BLOCK"
append_tr_block "$HOOKS_DIR/post-checkout" "$POST_CHECKOUT_BLOCK"
append_tr_block "$HOOKS_DIR/pre-push" "$PRE_PUSH_BLOCK"

echo "Installed TR auto-checkpoint hooks (project: $PROJECT)"
echo "Hooks: pre-commit, post-commit, post-merge, post-checkout, pre-push"
