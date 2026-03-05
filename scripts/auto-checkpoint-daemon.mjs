import process from 'node:process';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const baseUrl = process.env.TR_MCP_BASE_URL || 'http://localhost:8090';
const mcpUrl = `${baseUrl}/mcp`;
const defaultProject = process.env.TR_PROJECT_DEFAULT || '';
const defaultMode = process.env.TR_AUTO_CHECKPOINT_MODE || 'project';
const defaultIntervalSec = Number(process.env.TR_AUTO_CHECKPOINT_INTERVAL_SEC || 180);

let loopBusy = false;
let stopped = false;
let tickCount = 0;
let lastFingerprint = '';

function readFlag(name, fallback = '') {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  return match.slice(prefix.length).trim();
}

function runGit(command) {
  try {
    return execSync(command, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function pickProject() {
  const fromFlag = readFlag('project', '');
  if (fromFlag) return fromFlag;
  const fromEnv = String(defaultProject || '').trim();
  if (fromEnv) return fromEnv;
  const fromRepo = runGit('basename "$(git rev-parse --show-toplevel)"');
  return fromRepo || 'tr-default-project';
}

function pickMode() {
  const fromFlag = readFlag('mode', defaultMode || 'project').toLowerCase();
  if (fromFlag === 'ephemeral' || fromFlag === 'pinned' || fromFlag === 'project') {
    return fromFlag;
  }
  return 'project';
}

function pickIntervalSec() {
  const fromFlag = Number(readFlag('interval_sec', String(defaultIntervalSec || 180)));
  if (!Number.isFinite(fromFlag)) return 180;
  return Math.max(30, Math.floor(fromFlag));
}

function summarizeDiffNames(raw) {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 120);
}

function buildFingerprint() {
  const branch = runGit('git rev-parse --abbrev-ref HEAD') || 'unknown-branch';
  const head = runGit('git rev-parse --short HEAD') || 'no-head';
  const staged = summarizeDiffNames(runGit('git diff --cached --name-only')).join('|');
  const changed = summarizeDiffNames(runGit('git diff --name-only')).join('|');
  const porcelain = runGit('git status --porcelain').replace(/\s+/g, ' ').trim();
  return `${branch}::${head}::${staged}::${changed}::${porcelain}`;
}

async function post(payload, sessionId = '') {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return { headers: res.headers, text };
}

function parseSse(body) {
  const line = body
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('data: '));
  if (!line) throw new Error(`Unexpected SSE payload: ${body}`);
  return JSON.parse(line.slice(6));
}

function parseTool(body) {
  const sse = parseSse(body);
  const text = sse?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : sse;
}

async function getStatus(project) {
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tr-auto-checkpoint-daemon', version: '0.1.0' }
    }
  });
  const sessionId = init.headers.get('mcp-session-id') || '';
  if (!sessionId) {
    throw new Error('Missing MCP session id.');
  }
  const response = await post({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'tr_status',
      arguments: { project }
    }
  }, sessionId);
  return parseTool(response.text);
}

function collectRepoState() {
  const branch = runGit('git rev-parse --abbrev-ref HEAD') || 'unknown-branch';
  const latestCommit = runGit('git rev-parse --short HEAD');
  const latestSubject = runGit('git log -1 --pretty=%s');
  const latestDescription = runGit('git log -1 --pretty=%b');
  const stagedFiles = summarizeDiffNames(runGit('git diff --cached --name-only'));
  const changedFiles = summarizeDiffNames(runGit('git diff --name-only'));
  const touched = Array.from(new Set([...stagedFiles, ...changedFiles])).slice(0, 120);
  return {
    branch,
    latest_commit: latestCommit || undefined,
    latest_subject: latestSubject || undefined,
    latest_description: latestDescription || undefined,
    staged_files: stagedFiles,
    changed_files: changedFiles,
    staged_count: stagedFiles.length,
    changed_count: changedFiles.length,
    files_touched: touched
  };
}

async function runAutoCheckpoint({
  project,
  mode,
  trigger,
  changed,
  reminderDue,
  fingerprint,
  reminderAnchor = '',
  repoState
}) {
  const init = await post({
    jsonrpc: '2.0',
    id: 11,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tr-auto-checkpoint-daemon', version: '0.1.0' }
    }
  });
  const sessionId = init.headers.get('mcp-session-id') || '';
  if (!sessionId) {
    throw new Error('Missing MCP session id.');
  }
  const idempotencySource = [
    'auto-checkpoint-daemon',
    project,
    mode,
    trigger,
    fingerprint || '',
    reminderAnchor || '',
    repoState?.branch || '',
    repoState?.latest_commit || '',
    String(repoState?.staged_count ?? 0),
    String(repoState?.changed_count ?? 0)
  ].join('::');
  const idempotencyKey = `auto-${trigger}-${crypto.createHash('sha1').update(idempotencySource).digest('hex').slice(0, 24)}`;

  const response = await post({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: {
      name: 'tr_auto_checkpoint',
      arguments: {
        project,
        mode,
        phase: 'post',
        trigger,
        idempotency_key: idempotencyKey,
        signal: {
          repo_fingerprint_changed: changed,
          reminder_due: reminderDue
        },
        repo_state: repoState
      }
    }
  }, sessionId);
  return parseTool(response.text);
}

async function tick({ project, mode }) {
  if (loopBusy || stopped) return;
  loopBusy = true;
  tickCount += 1;
  try {
    const repoState = collectRepoState();
    const fingerprint = buildFingerprint();
    const changed = Boolean(lastFingerprint) && fingerprint !== lastFingerprint;
    if (!lastFingerprint) {
      lastFingerprint = fingerprint;
    }

    let reminderDue = false;
    let reminderAnchor = '';
    try {
      const status = await getStatus(project);
      const scoped = status?.scoped || {};
      const reminder = scoped?.reminder || {};
      reminderDue = Boolean(reminder.reminder_due ?? scoped.reminder_due);
      reminderAnchor = String(reminder.last_checkpoint_at || scoped.last_checkpoint_at || '').trim();
    } catch (error) {
      console.error(`[tr-auto-checkpoint] tick=${tickCount} status-check-failed: ${error.message || String(error)}`);
    }

    let trigger = '';
    if (changed) {
      trigger = 'interval-change';
    } else if (reminderDue) {
      trigger = 'stale-interval';
    }

    if (!trigger) {
      console.log(`[tr-auto-checkpoint] tick=${tickCount} no-op (changed=${changed}, reminder_due=${reminderDue})`);
      return;
    }

    const payload = await runAutoCheckpoint({
      project,
      mode,
      trigger,
      changed,
      reminderDue,
      fingerprint,
      reminderAnchor,
      repoState
    });
    if (!payload?.ok) {
      throw new Error(`Auto checkpoint call failed: ${JSON.stringify(payload)}`);
    }
    if (payload?.skipped) {
      console.log(`[tr-auto-checkpoint] tick=${tickCount} skipped trigger=${trigger} reason=${payload?.decision?.reason || 'n/a'}`);
      return;
    }
    const checkpoint = payload?.checkpoint || {};
    lastFingerprint = fingerprint;
    console.log(`[tr-auto-checkpoint] tick=${tickCount} checkpoint=${trigger} event_id=${checkpoint.event_id || 'n/a'} event_seq=${checkpoint.event_seq ?? 'n/a'} deduped=${Boolean(checkpoint.deduped)}`);
  } finally {
    loopBusy = false;
  }
}

async function run() {
  const project = pickProject();
  const mode = pickMode();
  const intervalSec = pickIntervalSec();
  const once = readFlag('once', '').toLowerCase() === 'true';

  console.log(`[tr-auto-checkpoint] started project=${project} mode=${mode} interval_sec=${intervalSec} base_url=${baseUrl}`);
  if (once) {
    await tick({ project, mode });
    return;
  }

  const timer = setInterval(() => {
    void tick({ project, mode });
  }, intervalSec * 1000);

  process.on('SIGINT', () => {
    stopped = true;
    clearInterval(timer);
    console.log('[tr-auto-checkpoint] stopped (SIGINT)');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    stopped = true;
    clearInterval(timer);
    console.log('[tr-auto-checkpoint] stopped (SIGTERM)');
    process.exit(0);
  });

  await tick({ project, mode });
}

run().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
