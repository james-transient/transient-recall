# TR Daily Workflow

Recommended session rhythm to keep AI continuity reliable without adding overhead. Full docs: [transientintelligence.com/docs/transient-recall/daily-workflow](https://transientintelligence.com/docs/transient-recall/daily-workflow)

## Session start

```
Call tr_resume(project) and tr_status(project) first, then summarize my current goal.
```

## During work

- Checkpoint on major decisions and task boundary completions.
- Include `current_goal`, `context_capsule`, and `next_actions`.
- When code changes, include `files_touched` and concise `code_refs`.

## Session end

```
Call tr_checkpoint with blockers + next_actions before final response.
```

This creates a clean handoff point for the next session.

## Minimal checkpoint payload

```json
{
  "project": "my-project",
  "work_packet": {
    "current_goal": "Ship docs update",
    "context_capsule": "Refined TR setup docs and expanded troubleshooting",
    "decision_rationale": "Reduce onboarding friction for MCP users",
    "next_actions": ["Validate in client", "Publish docs"],
    "blockers": []
  }
}
```

## High-value payload contract

For each checkpoint, include when relevant:

- `current_goal` — one clear sentence of the objective now
- `context_capsule` — concise "what changed + why"
- `decision_rationale` — reason for the chosen approach
- `next_actions` — explicit next 1-3 actions
- `blockers` — open blockers
- `files_touched` — when code or files changed
- `code_refs` — concise references to changed code
- `commit_sha`, `commit_subject`, `branch` — from git (see [install-verify](install-verify.md#3-add-continuity-instructions))

## Session cadence (always)

- **Start:** `tr_resume` + `tr_status`, then set/confirm current goal
- **Mid-session:** checkpoint at meaningful decision boundaries
- **End-session:** checkpoint with blockers and next actions before final response
