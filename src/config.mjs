import dotenv from 'dotenv';

dotenv.config();

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFromEnv(name, fallback = false) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function deploymentModeFromEnv() {
  const explicit = String(process.env.TR_DEPLOYMENT_MODE || '').trim().toLowerCase();
  if (explicit === 'local' || explicit === 'staging' || explicit === 'production') {
    return explicit;
  }
  return process.env.NODE_ENV === 'production' ? 'production' : 'local';
}

const deploymentMode = deploymentModeFromEnv();
const isLocalMode = deploymentMode === 'local';
const authStrictDefault = !isLocalMode;

export const config = {
  port: intFromEnv('PORT', 8090),
  mcpRoute: process.env.MCP_ROUTE || '/mcp',
  sseRoute: process.env.MCP_SSE_ROUTE || '/sse',
  sseMessagesRoute: process.env.MCP_SSE_MESSAGES_ROUTE || '/messages',
  deploymentMode,
  isLocalMode,
  edgeBearerToken: process.env.MCP_EDGE_BEARER_TOKEN || '',
  authStrict: boolFromEnv('TR_AUTH_STRICT', authStrictDefault),
  dedupeWindowSec: intFromEnv('TR_DEDUPE_WINDOW_SEC', 0),
  staleCheckpointMinutes: intFromEnv('TR_STALE_CHECKPOINT_MINUTES', 20),
  databaseUrl: process.env.DATABASE_URL || '',
  defaultSubject: process.env.TR_DEFAULT_SUBJECT || 'local-dev-user',
  defaultTenant: process.env.TR_DEFAULT_TENANT || 'public'
};

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}

if (!config.isLocalMode) {
  if (!config.authStrict) {
    throw new Error('TR_AUTH_STRICT must be true when TR_DEPLOYMENT_MODE is staging/production.');
  }
  if (!config.edgeBearerToken) {
    throw new Error('MCP_EDGE_BEARER_TOKEN is required when TR_DEPLOYMENT_MODE is staging/production.');
  }
}
