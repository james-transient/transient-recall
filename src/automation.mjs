function normalizeString(value) {
  return String(value ?? '').trim();
}

export function summarizeDescription(value, max = 280) {
  const normalized = normalizeString(value).replace(/\s+/g, ' ');
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function normalizeStringArray(value, cap = 120) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeString(item))
    .filter(Boolean)
    .slice(0, cap);
}

function normalizeBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}

export function normalizeAutoTrigger(trigger = '') {
  const normalized = normalizeString(trigger).toLowerCase();
  const allowed = new Set([
    'manual',
    'history-import',
    'pre-commit',
    'post-commit',
    'post-merge',
    'post-checkout',
    'pre-push',
    'interval-change',
    'stale-interval'
  ]);
  if (allowed.has(normalized)) return normalized;
  return normalized || 'manual';
}

export function decideAutoCheckpoint({ trigger = 'manual', signal = {} } = {}) {
  const normalizedTrigger = normalizeAutoTrigger(trigger);
  const force = normalizeBool(signal.force, false);
  const reminderDue = normalizeBool(signal.reminder_due, false);
  const changed = normalizeBool(signal.repo_fingerprint_changed, false);

  if (force) {
    return {
      should_checkpoint: true,
      reason: 'forced',
      confidence: 'high',
      trigger: normalizedTrigger
    };
  }

  if (normalizedTrigger === 'interval-change') {
    return {
      should_checkpoint: changed,
      reason: changed ? 'repo_state_changed' : 'no_material_change',
      confidence: changed ? 'high' : 'low',
      trigger: normalizedTrigger
    };
  }

  if (normalizedTrigger === 'stale-interval') {
    return {
      should_checkpoint: reminderDue,
      reason: reminderDue ? 'stale_checkpoint_due' : 'checkpoint_still_fresh',
      confidence: reminderDue ? 'high' : 'low',
      trigger: normalizedTrigger
    };
  }

  // Boundary and manual events are high-signal and should checkpoint by default.
  return {
    should_checkpoint: true,
    reason: 'boundary_event',
    confidence: 'high',
    trigger: normalizedTrigger
  };
}

export function buildAutoWorkPacket({
  trigger = 'manual',
  phase = 'post',
  mode = 'project',
  repoState = {},
  fallbackProject = ''
} = {}) {
  const normalizedTrigger = normalizeAutoTrigger(trigger);
  const normalizedPhase = String(phase || 'post').toLowerCase() === 'pre' ? 'pre' : 'post';
  const branch = normalizeString(repoState.branch) || 'unknown-branch';
  const latestCommit = normalizeString(repoState.latest_commit);
  const latestSubject = normalizeString(repoState.latest_subject);
  const latestDescription = summarizeDescription(repoState.latest_description, 420);
  const project = normalizeString(repoState.project) || normalizeString(fallbackProject);
  const stagedFiles = normalizeStringArray(repoState.staged_files, 60);
  const changedFiles = normalizeStringArray(repoState.changed_files, 60);
  const filesTouched = normalizeStringArray(repoState.files_touched, 60);
  const touched = filesTouched.length > 0
    ? filesTouched
    : Array.from(new Set([...stagedFiles, ...changedFiles])).slice(0, 60);
  const stagedCount = Number.isFinite(Number(repoState.staged_count))
    ? Number(repoState.staged_count)
    : stagedFiles.length;
  const changedCount = Number.isFinite(Number(repoState.changed_count))
    ? Number(repoState.changed_count)
    : changedFiles.length;
  const checkoutFrom = normalizeString(repoState.checkout_from);
  const checkoutTo = normalizeString(repoState.checkout_to);
  const checkoutIsBranch = normalizeBool(repoState.checkout_is_branch, false);
  const pushRemote = normalizeString(repoState.push_remote);
  const pushUrl = normalizeString(repoState.push_url);

  const triggerLabelByType = {
    'pre-commit': 'Pre-commit checkpoint',
    'post-commit': 'Post-commit checkpoint',
    'post-merge': 'Post-merge checkpoint',
    'post-checkout': 'Post-checkout checkpoint',
    'pre-push': 'Pre-push checkpoint',
    'history-import': 'History import checkpoint',
    'interval-change': 'Interval change checkpoint',
    'stale-interval': 'Stale interval checkpoint',
    manual: 'Manual checkpoint'
  };
  const triggerLabel = triggerLabelByType[normalizedTrigger] || 'Workflow checkpoint';
  const phaseLabel = `${triggerLabel} on ${branch}`;

  const contextByTrigger = {
    'pre-commit': `Preparing commit on ${branch}. Staged files: ${stagedCount}; unstaged files: ${Math.max(0, changedCount - stagedCount)}. Focus is validating and finalizing a clean commit boundary.`,
    'post-commit': `Commit ${latestCommit || 'pending'} captured on ${branch}. ${latestSubject || 'No commit subject found.'} Changed files: ${touched.slice(0, 8).join(', ') || 'none'}.`,
    'post-merge': `Merge completed on ${branch}. Head is ${latestCommit || 'unknown'} (${latestSubject || 'no commit subject'}). Capture preserves branch integration state before further edits.`,
    'post-checkout': `Checkout completed: ${checkoutFrom || 'unknown'} -> ${checkoutTo || 'unknown'} on ${branch}. ${checkoutIsBranch ? 'Branch switch' : 'Path checkout'} recorded to prevent context drift between refs.`,
    'pre-push': `Preparing push from ${branch}${pushRemote ? ` to remote ${pushRemote}` : ''}. Head ${latestCommit || 'unknown'} (${latestSubject || 'no commit subject'}). Capture preserves rollout intent before remote update.`,
    'history-import': `Historical commit imported on ${branch}. Commit ${latestCommit || 'unknown'} (${latestSubject || 'no commit subject'}). ${latestDescription ? `Description: ${latestDescription}` : 'No commit description available.'} Captured from git history to bootstrap continuity context.`,
    'interval-change': `Detected repository state change on ${branch}. Head ${latestCommit || 'unknown'} (${latestSubject || 'no commit subject'}). Auto-capture preserves continuity between manual checkpoints.`,
    'stale-interval': `Checkpoint cadence became stale on ${branch}. Head ${latestCommit || 'unknown'} (${latestSubject || 'no commit subject'}). Auto-capture refreshes context confidence.`,
    manual: `Manual workflow capture on ${branch}. Head ${latestCommit || 'unknown'} (${latestSubject || 'no commit subject'}).`
  };
  const contextCapsule = contextByTrigger[normalizedTrigger] || contextByTrigger.manual;

  const codeNotesByTrigger = {
    'pre-commit': `Pre-commit snapshot on ${branch}. Review staged diff for final pass.`,
    'post-commit': `Committed changes on ${branch} with commit ${latestCommit || 'n/a'}.`,
    'post-merge': `Post-merge snapshot on ${branch}. Validate merged behavior and run verification suite.`,
    'post-checkout': `Post-checkout snapshot on ${branch}. Confirm intent and next actions for the new ref.`,
    'pre-push': `Pre-push snapshot on ${branch}. Validate CI assumptions and deployment readiness before remote update.`,
    'history-import': `Historical commit import snapshot on ${branch}.`,
    'interval-change': `Interval watcher detected changed workspace state on ${branch}.`,
    'stale-interval': `Interval watcher refreshed stale context on ${branch}.`,
    manual: `Manual snapshot on ${branch}.`
  };

  const nextActionsByTrigger = {
    'pre-commit': ['Run tests/lint', 'Create commit with final message'],
    'post-commit': ['Run tests on committed state', 'Prepare rollout notes'],
    'post-merge': ['Run integration test suite', 'Resolve merge follow-up tasks'],
    'post-checkout': ['Review task continuity on current ref', 'Checkpoint immediate plan for this branch'],
    'pre-push': ['Confirm CI/local tests pass', 'Push and watch remote checks'],
    'history-import': ['Review imported continuity context', 'Continue from latest milestone'],
    'interval-change': ['Continue implementation', 'Checkpoint after next decision boundary'],
    'stale-interval': ['Refresh context with latest decisions', 'Continue active workflow'],
    manual: ['Continue current task', 'Checkpoint after next milestone']
  };

  const recurringIssuesByTrigger = {
    'pre-commit': ['Pre-commit drift risk between staged and unstaged changes'],
    'post-commit': ['Confirm deployment and runtime parity after commit'],
    'post-merge': ['Hidden integration regressions after merge'],
    'post-checkout': ['Context drift after switching refs'],
    'pre-push': ['Remote CI mismatch with local environment'],
    'history-import': ['Legacy commits may lack full decision context or rationale'],
    'interval-change': ['Long-running sessions can drift from latest file changes'],
    'stale-interval': ['Context confidence drops when no checkpoints are captured for too long'],
    manual: ['Checkpoint cadence can drift during long sessions']
  };

  const patternsByTrigger = {
    'pre-commit': ['Pre-commit checkpoint', 'Structured work packet capture'],
    'post-commit': ['Commit-boundary checkpoint', 'Milestone handoff context'],
    'post-merge': ['Merge-boundary checkpoint', 'Integration handoff context'],
    'post-checkout': ['Ref-switch checkpoint', 'Context continuity reset'],
    'pre-push': ['Release-boundary checkpoint', 'Deployment intent capture'],
    'history-import': ['Historical continuity bootstrap', 'Git timeline recovery'],
    'interval-change': ['Periodic change capture', 'Auto continuity checkpoint'],
    'stale-interval': ['Stale-context refresh', 'Auto continuity checkpoint'],
    manual: ['Manual continuity checkpoint']
  };

  const goalByTrigger = {
    'pre-commit': 'Capture pre-commit implementation state',
    'post-commit': 'Preserve clean post-commit handoff context',
    'post-merge': 'Capture merged branch integration state',
    'post-checkout': 'Preserve continuity after ref switch',
    'pre-push': 'Capture release intent before remote push',
    'history-import': 'Bootstrap continuity from historical commit context',
    'interval-change': 'Auto-capture changed workspace continuity state',
    'stale-interval': 'Refresh stale continuity context automatically',
    manual: normalizedPhase === 'post'
      ? 'Preserve current handoff context'
      : 'Capture current in-progress state'
  };

  return {
    current_goal: goalByTrigger[normalizedTrigger] || goalByTrigger.manual,
    context_capsule: contextCapsule,
    decision_rationale: 'Workflow boundaries preserve implementation intent and reduce session drift.',
    implementation_notes: `${phaseLabel}. Latest commit subject: ${latestSubject || 'n/a'}${latestDescription ? ` | Commit description: ${latestDescription}` : ''}`,
    code_implementation_notes: codeNotesByTrigger[normalizedTrigger] || codeNotesByTrigger.manual,
    code_refs: touched,
    tech_stack_hints: ['nodejs', 'mcp', 'postgresql'],
    recurring_issues: recurringIssuesByTrigger[normalizedTrigger] || recurringIssuesByTrigger.manual,
    code_patterns: patternsByTrigger[normalizedTrigger] || patternsByTrigger.manual,
    handoff_notes: normalizedPhase === 'post'
      ? 'Next checkpoint should capture validation/deployment outcomes.'
      : 'After completing this boundary, capture the next state transition checkpoint.',
    branch,
    trigger: normalizedTrigger,
    mode,
    project: project || undefined,
    checkout_from: checkoutFrom || undefined,
    checkout_to: checkoutTo || undefined,
    checkout_is_branch: checkoutIsBranch,
    push_remote: pushRemote || undefined,
    push_url: pushUrl || undefined,
    commit_sha: latestCommit || undefined,
    commit_subject: latestSubject || undefined,
    files_touched: touched,
    next_actions: nextActionsByTrigger[normalizedTrigger] || nextActionsByTrigger.manual
  };
}
