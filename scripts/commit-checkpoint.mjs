import process from 'node:process';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const baseUrl = process.env.TR_MCP_BASE_URL || 'http://localhost:8090';
const mcpUrl = `${baseUrl}/mcp`;
const defaultProject = process.env.TR_PROJECT_DEFAULT || '';

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

function summarizeDiffNames(raw) {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 60);
}

function pickTrigger(phase) {
  const fromFlag = (readFlag('trigger', '') || '').trim().toLowerCase();
  if (fromFlag) return fromFlag;
  return phase === 'pre' ? 'pre-commit' : 'post-commit';
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildRepoState() {
  const branch = runGit('git rev-parse --abbrev-ref HEAD') || 'unknown-branch';
  const latestCommit = runGit('git rev-parse --short HEAD');
  const latestSubject = runGit('git log -1 --pretty=%s');
  const latestDescription = runGit('git log -1 --pretty=%b');
  const stagedFiles = summarizeDiffNames(runGit('git diff --cached --name-only'));
  const changedFiles = summarizeDiffNames(runGit('git diff --name-only'));
  const touched = Array.from(new Set([...stagedFiles, ...changedFiles])).slice(0, 60);
  const stagedCount = stagedFiles.length;
  const changedCount = changedFiles.length;

  const checkoutFrom = readFlag('checkout_from', '');
  const checkoutTo = readFlag('checkout_to', '');
  const checkoutIsBranch = toInt(readFlag('checkout_is_branch', '0')) === 1;
  const pushRemote = readFlag('push_remote', '');
  const pushUrl = readFlag('push_url', '');

  return {
    branch,
    latest_commit: latestCommit || undefined,
    latest_subject: latestSubject || undefined,
    latest_description: latestDescription || undefined,
    staged_files: stagedFiles,
    changed_files: changedFiles,
    staged_count: stagedCount,
    changed_count: changedCount,
    files_touched: touched,
    checkout_from: checkoutFrom || undefined,
    checkout_to: checkoutTo || undefined,
    checkout_is_branch: checkoutIsBranch,
    push_remote: pushRemote || undefined,
    push_url: pushUrl || undefined
  };
}

function buildDeterministicIdempotencyKey({ trigger, phase, project, mode, repoState }) {
  const source = [
    'commit-checkpoint',
    trigger,
    phase,
    project,
    mode,
    repoState?.branch || '',
    repoState?.latest_commit || '',
    String(repoState?.staged_count ?? 0),
    String(repoState?.changed_count ?? 0),
    (repoState?.files_touched || []).join('|'),
    repoState?.checkout_from || '',
    repoState?.checkout_to || '',
    String(Boolean(repoState?.checkout_is_branch)),
    repoState?.push_remote || ''
  ].join('::');
  const digest = crypto.createHash('sha1').update(source).digest('hex').slice(0, 24);
  return `checkpoint-${trigger}-${digest}`;
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

async function run() {
  const phaseRaw = (readFlag('phase', 'post') || 'post').toLowerCase();
  const phase = phaseRaw === 'pre' ? 'pre' : 'post';
  const trigger = pickTrigger(phase);
  const project = pickProject();
  const mode = readFlag('mode', 'project') || 'project';
  const repoState = buildRepoState();
  const key = readFlag('idempotency_key', buildDeterministicIdempotencyKey({
    trigger,
    phase,
    project,
    mode,
    repoState
  }));

  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tr-commit-checkpoint', version: '0.1.0' }
    }
  });
  const sessionId = init.headers.get('mcp-session-id') || '';
  if (!sessionId) throw new Error('Missing MCP session id.');

  const result = await post({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'tr_auto_checkpoint',
      arguments: {
        project,
        phase,
        trigger,
        mode,
        idempotency_key: key,
        signal: {
          force: true
        },
        repo_state: repoState
      }
    }
  }, sessionId);

  const payload = parseTool(result.text);
  if (!payload?.ok || payload?.skipped) {
    throw new Error(`Checkpoint failed: ${JSON.stringify(payload)}`);
  }
  const checkpoint = payload?.checkpoint || {};
  console.log(JSON.stringify({
    ok: true,
    phase,
    trigger,
    project,
    event_id: checkpoint.event_id,
    event_seq: checkpoint.event_seq,
    deduped: checkpoint.deduped
  }, null, 2));
}

run().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
