#!/usr/bin/env node

import crypto from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.mjs';
import { getSystemStatus, healthCheck } from './db.mjs';
import { createTrMcpServer } from './tr-mcp-core.mjs';

const app = createMcpExpressApp({ host: '0.0.0.0' });
const transports = {};

function jsonRpcError(res, status, message, code = -32603) {
  return res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null
  });
}

function injectAuthContextIntoToolArgs(req) {
  const subjectHeader = String(req.headers['x-tr-subject'] || '').trim();
  const tenantHeader = String(req.headers['x-tr-tenant'] || '').trim();
  const projectHeader = String(req.headers['x-tr-project'] || '').trim();
  const authContext = {};
  if (subjectHeader) authContext.subject = subjectHeader;
  if (tenantHeader) authContext.tenant = tenantHeader;
  if (projectHeader) authContext.default_project = projectHeader;
  if (req.body?.params?.arguments && typeof req.body.params.arguments === 'object') {
    req.body.params.arguments.__auth_context = authContext;
  }
}

function edgeGuard(req, res, next) {
  if (!config.edgeBearerToken) return next();
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== config.edgeBearerToken) {
    return jsonRpcError(res, 401, 'Unauthorized');
  }
  return next();
}

async function createStreamableTransport() {
  let initializedSessionId = '';
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => {
      initializedSessionId = sessionId;
      transports[sessionId] = transport;
    }
  });
  transport.onclose = () => {
    const sessionId = initializedSessionId || transport.sessionId;
    if (sessionId && transports[sessionId]) {
      delete transports[sessionId];
    }
  };
  const server = createTrMcpServer();
  await server.connect(transport);
  return transport;
}

app.get('/healthz', async (_req, res) => {
  try {
    await healthCheck();
    const system = await getSystemStatus();
    return res.status(200).json({
      service: 'tr-mcp-service',
      status: 'ok',
      transport: {
        streamable_http: config.mcpRoute,
        sse: config.sseRoute,
        sse_messages: config.sseMessagesRoute
      },
      system
    });
  } catch (error) {
    return res.status(503).json({
      service: 'tr-mcp-service',
      status: 'degraded',
      error: error?.message || String(error)
    });
  }
});

app.all(config.mcpRoute, edgeGuard, async (req, res) => {
  try {
    injectAuthContextIntoToolArgs(req);
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && transports[sessionId] instanceof StreamableHTTPServerTransport) {
      transport = transports[sessionId];
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      transport = await createStreamableTransport();
    } else {
      return jsonRpcError(res, 400, 'Bad Request: No valid session ID provided.', -32600);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    return jsonRpcError(res, 500, error?.message || 'Internal server error');
  }
});

app.get(config.sseRoute, edgeGuard, async (_req, res) => {
  try {
    const transport = new SSEServerTransport(config.sseMessagesRoute, res);
    transports[transport.sessionId] = transport;
    transport.onclose = () => {
      if (transports[transport.sessionId]) delete transports[transport.sessionId];
    };
    const server = createTrMcpServer();
    await server.connect(transport);
  } catch (error) {
    if (!res.headersSent) res.status(500).send(error?.message || 'SSE initialization failed');
  }
});

app.post(config.sseMessagesRoute, edgeGuard, async (req, res) => {
  try {
    injectAuthContextIntoToolArgs(req);
    const sessionId = req.query.sessionId;
    const transport = transports[sessionId];
    if (!(transport instanceof SSEServerTransport)) {
      return jsonRpcError(res, 404, 'Session not found.');
    }
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).send(error?.message || 'SSE post message failed');
  }
});

export function startServer() {
  app.listen(config.port, (error) => {
    if (error) {
      console.error('[TR-MCP] Failed to start:', error);
      process.exit(1);
    }
    console.log(`[TR-MCP] Listening on :${config.port}`);
    console.log(`[TR-MCP] Streamable endpoint: ${config.mcpRoute}`);
    console.log(`[TR-MCP] SSE endpoint: ${config.sseRoute}`);
  });
}
