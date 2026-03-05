# TR Daily Workflow

Recommended cadence to keep continuity reliable with low overhead.

## Session start

```text
Call tr_resume(project) and tr_status(project) first, then summarize my current goal.
```

## During work

- Checkpoint on major decisions and task-boundary completions.
- Include `current_goal`, `context_capsule`, and `next_actions`.
- When code changes, include `files_touched` and concise `code_refs`.

## Session end

```text
Call tr_checkpoint with blockers + next_actions before final response.
```

## Minimal checkpoint shape

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
