#!/usr/bin/env node
/**
 * Merge Transient Recall MCP server into Cursor mcp.json.
 * Default behavior is non-destructive:
 * - always updates URL
 * - preserves existing headers/project mapping
 * Use --force (or TR_CONFIGURE_CURSOR_FORCE=1) to reset headers/project defaults.
 * Usage: node configure-cursor-mcp.mjs <path-to-mcp.json> <mcp-url> [project] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';

const mcpPath = process.argv[2] || '';
const mcpUrl = process.argv[3] || 'http://localhost:8090/mcp';
const project = process.argv[4] || path.basename(process.cwd());
const force = process.argv.includes('--force') || process.env.TR_CONFIGURE_CURSOR_FORCE === '1';

if (!mcpPath) {
  console.error('Usage: node configure-cursor-mcp.mjs <mcp.json path> [mcp-url] [project] [--force]');
  process.exit(1);
}

const dir = path.dirname(mcpPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

let cfg = { mcpServers: {} };
if (fs.existsSync(mcpPath)) {
  try {
    cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  } catch {
    // use default
  }
}
cfg.mcpServers = cfg.mcpServers || {};
const defaultHeaders = {
  'x-tr-subject': 'local-dev-user',
  'x-tr-tenant': 'public'
};
if (project) defaultHeaders['x-tr-project'] = project;

const existingServer = cfg.mcpServers['transient-recall-local'] || {};
const hasExistingHeaders = !!(existingServer && typeof existingServer === 'object' && existingServer.headers && typeof existingServer.headers === 'object');
const existingUrl = typeof existingServer.url === 'string' ? existingServer.url : null;
const existingProject = hasExistingHeaders ? existingServer.headers['x-tr-project'] : null;

const nextServer = {
  ...existingServer,
  url: mcpUrl
};

if (force || !hasExistingHeaders) {
  // Force mode (or first-time setup) writes recommended TR local defaults.
  nextServer.headers = defaultHeaders;
}

const warnings = [];
if (existingUrl && existingUrl !== mcpUrl) {
  warnings.push(`MCP URL change: ${existingUrl} -> ${mcpUrl}`);
}
if (!force && hasExistingHeaders && project && existingProject && existingProject !== project) {
  warnings.push(`Preserving existing x-tr-project "${existingProject}" (requested "${project}" ignored in safe mode).`);
}
if (!force && hasExistingHeaders && !('x-tr-project' in existingServer.headers) && project) {
  warnings.push('Existing headers have no x-tr-project; safe mode will not add one. Use --force to set defaults.');
}

cfg.mcpServers['transient-recall-local'] = nextServer;

fs.writeFileSync(mcpPath, JSON.stringify(cfg, null, 2));
console.log('Updated', mcpPath);
console.log('Configured project mapping:', (nextServer.headers && nextServer.headers['x-tr-project']) || '(none)');
console.log('Config mode:', force ? 'force (reset headers/project)' : 'safe (preserve existing headers/project)');
if (warnings.length) {
  for (const item of warnings) {
    console.log(`Warning: ${item}`);
  }
}
