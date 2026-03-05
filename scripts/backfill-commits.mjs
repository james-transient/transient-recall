import process from 'node:process';
import { execSync } from 'node:child_process';
import { basename as pathBasename } from 'node:path';

const baseUrl = process.env.TR_MCP_BASE_URL || 'http://localhost:8090';
const mcpUrl = `${baseUrl}/mcp`;
const defaultProject = process.env.TR_PROJECT_DEFAULT || '';
const defaultBackfillMaxCount = Number(process.env.TR_BACKFILL_MAX_COUNT || 1000);
const defaultBackfillMaxFiles = Number(process.env.TR_BACKFILL_MAX_FILES || 240);

function readFlag(name, fallback = '') {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  return match.slice(prefix.length).trim();
}

function readBoolFlag(name, fallback = false) {
  const raw = String(readFlag(name, fallback ? 'true' : 'false')).trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
}

function withRepoRoot(command, repoRoot = '') {
  const root = String(repoRoot || '').trim();
  if (!root) return command;
  if (command.startsWith('git ')) {
    return `git -C ${JSON.stringify(root)} ${command.slice(4)}`;
  }
  return command;
}

function runGit(command, repoRoot = '') {
  try {
    return execSync(withRepoRoot(command, repoRoot), { encoding: 'utf8' }).trim();
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    const stdout = error?.stdout ? String(error.stdout) : '';
    const details = [stderr, stdout].filter(Boolean).join('\n').trim();
    throw new Error(`Git command failed: ${withRepoRoot(command, repoRoot)}${details ? `\n${details}` : ''}`);
  }
}

function tryGit(command, repoRoot = '') {
  try {
    return execSync(withRepoRoot(command, repoRoot), { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function pickProject(repoRoot = '') {
  const fromFlag = readFlag('project', '');
  if (fromFlag) return fromFlag;
  const fromEnv = String(defaultProject || '').trim();
  if (fromEnv) return fromEnv;
  const root = tryGit('git rev-parse --show-toplevel', repoRoot);
  const fromRepo = root ? pathBasename(root) : '';
  return fromRepo || 'tr-default-project';
}

function pickMode() {
  const raw = String(readFlag('mode', 'project')).trim().toLowerCase();
  if (raw === 'ephemeral' || raw === 'project' || raw === 'pinned') return raw;
  return 'project';
}

function pickIdempotencyScope() {
  const raw = String(readFlag('idempotency_scope', 'global')).trim().toLowerCase();
  if (raw === 'global' || raw === 'repo') return raw;
  return 'global';
}

function normalizeKeyFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 160);
}

function pickMaxCount() {
  const fallback = Number.isFinite(defaultBackfillMaxCount) ? defaultBackfillMaxCount : 1000;
  const raw = Number(readFlag('max_count', String(fallback)));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(Math.floor(raw), 50000));
}

function pickMaxFilesPerCommit() {
  const fallback = Number.isFinite(defaultBackfillMaxFiles) ? defaultBackfillMaxFiles : 240;
  const raw = Number(readFlag('max_files_per_commit', String(fallback)));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(10, Math.min(Math.floor(raw), 1000));
}

function normalizeSinceValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // Git can misinterpret plain YYYY-MM-DD as a relative expression on some setups.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00Z`;
  }
  return raw;
}

function parseSinceDate(value) {
  const normalized = normalizeSinceValue(value);
  if (!normalized) return null;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseLogLine(line) {
  const parts = line.split('\u001f');
  return {
    sha: parts[0] || '',
    short_sha: parts[1] || '',
    author_date: parts[2] || '',
    author_name: parts[3] || '',
    subject: parts[4] || '',
    body: parts[5] || ''
  };
}

function parseNameStatus(raw) {
  if (!raw) return [];
  const files = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t').filter(Boolean);
    if (parts.length < 2) continue;
    const status = parts[0];
    // Rename lines can include old and new paths; keep newest path.
    const path = parts[parts.length - 1];
    files.push({ status, path });
  }
  return files;
}

function loadCommits({ maxCount, since, from, to, firstParent, includeMerges, allHistory, repoRoot }) {
  const format = '%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%b%x1e';
  const flags = [];
  flags.push('--reverse');
  if (!allHistory) flags.push(`--max-count=${maxCount}`);
  const normalizedSince = normalizeSinceValue(since);
  const sinceDate = parseSinceDate(since);
  if (!allHistory && normalizedSince) flags.push(`--since=${normalizedSince}`);
  if (firstParent) flags.push('--first-parent');
  if (!includeMerges) flags.push('--no-merges');

  let range = '';
  if (from && to) {
    range = `${from}..${to}`;
  } else if (from) {
    range = `${from}..HEAD`;
  } else if (to) {
    range = to;
  }

  const command = `git log ${flags.join(' ')} --format=${JSON.stringify(format)} ${range}`.trim();
  const output = runGit(command, repoRoot);
  if (!output) return [];

  return output
    .split('\u001e')
    .map((line) => line.replace(/\s+$/g, '').trim())
    .filter(Boolean)
    .map(parseLogLine)
    .filter((commit) => {
      if (!sinceDate) return true;
      const commitDate = new Date(commit.author_date);
      if (Number.isNaN(commitDate.getTime())) return false;
      return commitDate.getTime() >= sinceDate.getTime();
    })
    .filter((commit) => commit.sha);
}

function summarizeFiles(files, limit = 24) {
  return files
    .map((item) => item.path)
    .filter(Boolean)
    .slice(0, limit)
    .join(', ');
}

function buildCommitDescription(commit, files, body = '') {
  const normalizedBody = String(body || '').replace(/\s+/g, ' ').trim();
  const parts = [
    `Author: ${commit.author_name || 'unknown'}`,
    `Date: ${commit.author_date || 'unknown'}`,
    `Files changed: ${files.length}`
  ];
  const fileSummary = summarizeFiles(files, 24);
  if (fileSummary) parts.push(`Top files: ${fileSummary}`);
  if (normalizedBody) parts.push(`Body: ${normalizedBody}`);
  return parts.join(' | ');
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
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

async function callTool(sessionId, id, name, args) {
  const response = await post({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: args
    }
  }, sessionId);
  return parseTool(response.text);
}

function buildRepoState(commit, branch, files, latestDescription = '', maxFilesPerCommit = 240) {
  const paths = files
    .map((item) => item.path)
    .filter(Boolean)
    .slice(0, maxFilesPerCommit);
  return {
    branch,
    latest_commit: commit.short_sha || commit.sha.slice(0, 7),
    latest_subject: commit.subject || '',
    latest_description: String(latestDescription || '').trim(),
    files_touched: paths,
    changed_files: paths,
    staged_files: [],
    staged_count: 0,
    changed_count: paths.length
  };
}

async function run() {
  const repoRoot = String(readFlag('repo_root', process.cwd())).trim();
  // Validate target repo early.
  runGit('git rev-parse --show-toplevel', repoRoot);

  const project = pickProject(repoRoot);
  const mode = pickMode();
  const maxCount = pickMaxCount();
  const since = readFlag('since', '');
  const from = readFlag('from', '');
  const to = readFlag('to', '');
  const firstParent = readBoolFlag('first_parent', true);
  const includeMerges = readBoolFlag('include_merges', false);
  const allHistory = readBoolFlag('all_history', false);
  const dryRun = readBoolFlag('dry_run', false);
  const maxFilesPerCommit = pickMaxFilesPerCommit();
  const idempotencyScope = pickIdempotencyScope();
  const idempotencyNamespaceFlag = readFlag('idempotency_namespace', '');
  const detectedRoot = runGit('git rev-parse --show-toplevel', repoRoot);
  const repoName = detectedRoot ? pathBasename(detectedRoot) : '';
  const idempotencyNamespace = normalizeKeyFragment(idempotencyNamespaceFlag || repoName || detectedRoot);
  const branch = tryGit('git rev-parse --abbrev-ref HEAD', repoRoot) || 'unknown-branch';

  const commits = loadCommits({
    maxCount,
    since,
    from,
    to,
    firstParent,
    includeMerges,
    allHistory,
    repoRoot
  });

  if (commits.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      project,
      imported: 0,
      deduped: 0,
      skipped: 0,
      errors: 0,
      dry_run: dryRun,
      message: 'No commits matched filters.'
    }, null, 2));
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      project,
      dry_run: true,
      all_history: allHistory,
      repo_root: detectedRoot || repoRoot,
      idempotency_scope: idempotencyScope,
      idempotency_namespace: idempotencyScope === 'repo' ? (idempotencyNamespace || null) : null,
      commit_count: commits.length,
      sample: commits.slice(0, 5).map((commit) => ({
        sha: commit.sha,
        subject: commit.subject,
        author_date: commit.author_date
      }))
    }, null, 2));
    return;
  }

  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tr-backfill-commits', version: '0.1.0' }
    }
  });
  const sessionId = init.headers.get('mcp-session-id') || '';
  if (!sessionId) throw new Error('Missing MCP session id.');

  let imported = 0;
  let deduped = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < commits.length; i += 1) {
    const commit = commits[i];
    const files = parseNameStatus(tryGit(`git show --name-status --format= ${commit.sha}`, repoRoot));
    const commitBody = tryGit(`git show -s --format=%b ${commit.sha}`, repoRoot);
    const commitDescription = buildCommitDescription(commit, files, commitBody);
    const repoState = buildRepoState(commit, branch, files, commitDescription, maxFilesPerCommit);
    const idempotencyKey = idempotencyScope === 'repo' && idempotencyNamespace
      ? `history-import:${project}:${idempotencyNamespace}:${commit.sha}`
      : `history-import:${project}:${commit.sha}`;
    try {
      const payload = await callTool(sessionId, 1000 + i, 'tr_auto_checkpoint', {
        project,
        trigger: 'history-import',
        phase: 'post',
        mode,
        idempotency_key: idempotencyKey,
        signal: {
          force: true
        },
        repo_state: repoState
      });
      if (!payload?.ok) {
        errors += 1;
        console.error(`[backfill] error sha=${commit.sha}: ${JSON.stringify(payload)}`);
        continue;
      }
      if (payload?.skipped) {
        skipped += 1;
        continue;
      }
      if (payload?.checkpoint?.deduped) {
        deduped += 1;
      } else {
        imported += 1;
      }
    } catch (error) {
      errors += 1;
      console.error(`[backfill] error sha=${commit.sha}: ${error.message || String(error)}`);
    }
  }

  console.log(JSON.stringify({
    ok: errors === 0,
    project,
    dry_run: false,
    all_history: allHistory,
    repo_root: detectedRoot || repoRoot,
    idempotency_scope: idempotencyScope,
    idempotency_namespace: idempotencyScope === 'repo' ? (idempotencyNamespace || null) : null,
    commit_count: commits.length,
    imported,
    deduped,
    skipped,
    errors
  }, null, 2));
}

run().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
