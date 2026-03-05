# TR rules (copy-paste)

For humans: copy each code block into `.cursor/rules/<filename>` in your workspace.

For AI agents: paste the instruction + code block below. Create the file at the given path and write the content. Paths: Cursor/Windsurf use `.cursor/rules/`; other IDEs may use similar rule directories—adapt if needed.

---

## tr-continuity.mdc

**Agent instruction:** Create `.cursor/rules/tr-continuity.mdc` in the workspace root with exactly this content:

```mdc
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
```

---

## tr-checkpoint-git-enrich.mdc

**Agent instruction:** Create `.cursor/rules/tr-checkpoint-git-enrich.mdc` in the workspace root with exactly this content:

```mdc
---
description: Enrich TR checkpoints with git state (commit_sha, branch, files_touched)
globs: 
alwaysApply: true
---

# TR Checkpoint Git Enrichment

When calling `tr_checkpoint` (or `tr_auto_checkpoint` with `repo_state`), **always run git in the workspace first** and pass the results into the work_packet. TR runs in Docker and cannot access your filesystem—enrichment is client-side only.

## Before checkpointing

Run these in the relevant workspace root (e.g. the repo you're working in):

    git rev-parse --short HEAD
    git rev-parse --abbrev-ref HEAD
    git log -1 --pretty=%s
    git diff --cached --name-only; git diff --name-only

## Pass into tr_checkpoint work_packet

- `commit_sha`: output of `git rev-parse --short HEAD`
- `commit_subject`: output of `git log -1 --pretty=%s`
- `files_touched`: combined staged + unstaged file names (from `git diff --cached --name-only` and `git diff --name-only`), capped at ~60
- Include `branch` in `context_capsule` if useful, e.g. `"On branch fix/install-recall. Commit abc123: Add deployment mode patch."`

## Example

    {
      "project": "Transient_Recall_API",
      "work_packet": {
        "current_goal": "...",
        "context_capsule": "On branch main. Commit abc1234: Fix auth_header for set -u.",
        "commit_sha": "abc1234",
        "commit_subject": "fix: auth_header unbound variable under set -u",
        "files_touched": ["scripts/install-artifact.sh", "app/install/recall/route.ts"]
      }
    }

## Multi-workspace

If multiple repos are open, run git in each and use the primary repo's data for the checkpoint, or the repo that matches the `project` name.
```

---

## One-shot agent prompt (IDE-agnostic)

Paste the block below to your coding agent (Cursor, Copilot, Windsurf, Claude, etc.). The agent will create both rule files. Use `.cursor/rules/` if your IDE supports it; otherwise adapt the path to your IDE's rules directory.

```
[INSTALL TR RULES] Create these two files in the workspace root. Path: .cursor/rules/ (or your IDE's equivalent rules directory).

FILE 1: .cursor/rules/tr-continuity.mdc
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

---

FILE 2: .cursor/rules/tr-checkpoint-git-enrich.mdc
---
description: Enrich TR checkpoints with git state (commit_sha, branch, files_touched)
globs: 
alwaysApply: true
---

# TR Checkpoint Git Enrichment

When calling `tr_checkpoint` (or `tr_auto_checkpoint` with `repo_state`), **always run git in the workspace first** and pass the results into the work_packet. TR runs in Docker and cannot access your filesystem—enrichment is client-side only.

## Before checkpointing

Run these in the relevant workspace root (e.g. the repo you're working in):

    git rev-parse --short HEAD
    git rev-parse --abbrev-ref HEAD
    git log -1 --pretty=%s
    git diff --cached --name-only; git diff --name-only

## Pass into tr_checkpoint work_packet

- `commit_sha`: output of `git rev-parse --short HEAD`
- `commit_subject`: output of `git log -1 --pretty=%s`
- `files_touched`: combined staged + unstaged file names (from `git diff --cached --name-only` and `git diff --name-only`), capped at ~60
- Include `branch` in `context_capsule` if useful, e.g. `"On branch fix/install-recall. Commit abc123: Add deployment mode patch."`

## Example

    {
      "project": "Transient_Recall_API",
      "work_packet": {
        "current_goal": "...",
        "context_capsule": "On branch main. Commit abc1234: Fix auth_header for set -u.",
        "commit_sha": "abc1234",
        "commit_subject": "fix: auth_header unbound variable under set -u",
        "files_touched": ["scripts/install-artifact.sh", "app/install/recall/route.ts"]
      }
    }

## Multi-workspace

If multiple repos are open, run git in each and use the primary repo's data for the checkpoint, or the repo that matches the `project` name.
```
