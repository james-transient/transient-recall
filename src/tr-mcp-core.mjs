import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createCheckpoint,
  getBlockers,
  getGraphDiff,
  getGraphView,
  getProjects,
  getResume,
  searchCheckpoints,
  getScopeStatus,
  getSystemStatus,
  getTimeline
} from './db.mjs';
import {
  buildAutoWorkPacket,
  decideAutoCheckpoint,
  normalizeAutoTrigger
} from './automation.mjs';
import { config } from './config.mjs';

function asToolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  };
}

function getAuthIdentity(args = {}) {
  const auth = args?.__auth_context && typeof args.__auth_context === 'object'
    ? args.__auth_context
    : {};
  const subject = String(auth.subject || '').trim();
  const tenant = String(auth.tenant || '').trim();
  if (config.authStrict && (!subject || !tenant)) {
    const error = new Error('Auth context is required in strict mode.');
    error.code = 'auth_required';
    throw error;
  }
  return {
    subject: subject || config.defaultSubject,
    tenant: tenant || config.defaultTenant || 'public'
  };
}

function requiredProject(args) {
  const auth = args?.__auth_context && typeof args.__auth_context === 'object' ? args.__auth_context : {};
  const project = String(args?.project || auth?.default_project || '').trim();
  if (!project) {
    const error = new Error('project is required. Pass project in tool args or set x-tr-project header.');
    error.code = 'missing_project';
    throw error;
  }
  return project;
}

function asErrorPayload(error) {
  const code = error?.code || 'internal_error';
  const nextSteps = code === 'missing_project'
    ? ['Provide project and retry.']
    : (code === 'invalid_timestamp'
      ? ['Provide ISO timestamp values for since/until (e.g. 2026-03-01T00:00:00Z).']
      : (code === 'invalid_query'
        ? ['Provide query text and retry.']
    : (code === 'not_found'
      ? ['Create a checkpoint first, then retry resume/timeline.']
      : (code === 'auth_required'
        ? ['Provide x-tr-subject and x-tr-tenant headers.', 'Local-only fallback can be enabled with TR_DEPLOYMENT_MODE=local.']
        : ['Retry request or inspect server logs.']))));
  return {
    ok: false,
    error: error?.message || String(error),
    error_code: code,
    next_steps: nextSteps
  };
}

function workflowPolicy() {
  return {
    policy_version: 'v1',
    objective: 'Capture deterministic workflow continuity with minimal structured memory.',
    canonical_flow: [
      'At session start, call tr_resume(project).',
      'During work, checkpoint on major decision/task transition with an AI-written context_capsule.',
      'Capture checkpoints at pre-commit and post-commit boundaries for cleaner implementation snapshots.',
      'When evidence work is involved, include ti_refs in work_packet.',
      'At session end, call tr_checkpoint with next_actions and blockers.'
    ],
    auto_checkpoint_triggers: [
      'material_state_change',
      'task_boundary_completed',
      'commit_boundary_pre',
      'commit_boundary_post',
      'stale_checkpoint_elapsed',
      'session_transition_intent',
      'post_evidence_result'
    ],
    constraints: [
      'Do not store raw transcript by default.',
      'Prefer structured work_packet fields over freeform notes, including context_capsule.',
      'Use idempotency_key for retries to avoid duplicate events.'
    ],
    data_minimization: {
      retention_classes: ['ephemeral', 'project', 'pinned'],
      dedupe_window_seconds: config.dedupeWindowSec
    }
  };
}

export function createTrMcpServer() {
  const server = new Server(
    { name: 'tr-mcp-server', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'tr_checkpoint',
        description: 'Append a structured work-packet checkpoint event and update current project state.',
        inputSchema: {
          type: 'object',
          required: ['project', 'work_packet'],
          properties: {
            project: { type: 'string' },
            work_packet: {
              type: 'object',
              required: ['current_goal', 'context_capsule'],
              properties: {
                current_goal: { type: 'string' },
                context_capsule: { type: 'string' },
                decision_rationale: { type: 'string' },
                implementation_notes: { type: 'string' },
                code_implementation_notes: { type: 'string' },
                code_refs: { type: 'array', items: { type: 'string' } },
                files_touched: { type: 'array', items: { type: 'string' } },
                commit_sha: { type: 'string' },
                commit_subject: { type: 'string' },
                tech_stack_hints: { type: 'array', items: { type: 'string' } },
                recurring_issues: { type: 'array', items: { type: 'string' } },
                code_patterns: { type: 'array', items: { type: 'string' } },
                handoff_notes: { type: 'string' }
              }
            },
            mode: { type: 'string', enum: ['ephemeral', 'project', 'pinned'] },
            idempotency_key: { type: 'string' }
          }
        }
      },
      {
        name: 'tr_resume',
        description: 'Return latest deterministic context pack plus recent continuity trail.',
        inputSchema: {
          type: 'object',
          required: ['project'],
          properties: {
            project: { type: 'string' },
            include_ti_refs: { type: 'boolean' },
            history_limit: { type: 'number' }
          }
        }
      },
      {
        name: 'tr_workflow_policy',
        description: 'Return canonical TR workflow and auto-checkpoint policy.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'tr_status',
        description: 'Return TR system readiness and scoped continuity stats.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string' }
          }
        }
      },
      {
        name: 'tr_auto_should_checkpoint',
        description: 'Evaluate whether an automation signal should create a checkpoint.',
        inputSchema: {
          type: 'object',
          required: ['project'],
          properties: {
            project: { type: 'string' },
            trigger: { type: 'string' },
            signal: {
              type: 'object',
              properties: {
                force: { type: 'boolean' },
                reminder_due: { type: 'boolean' },
                repo_fingerprint_changed: { type: 'boolean' }
              }
            }
          }
        }
      },
      {
        name: 'tr_auto_work_packet',
        description: 'Build a standardized automation work_packet from repo/workflow state.',
        inputSchema: {
          type: 'object',
          required: ['project'],
          properties: {
            project: { type: 'string' },
            trigger: { type: 'string' },
            phase: { type: 'string', enum: ['pre', 'post'] },
            mode: { type: 'string', enum: ['ephemeral', 'project', 'pinned'] },
            repo_state: {
              type: 'object',
              properties: {
                project: { type: 'string' },
                branch: { type: 'string' },
                latest_commit: { type: 'string' },
                latest_subject: { type: 'string' },
                staged_count: { type: 'number' },
                changed_count: { type: 'number' },
                staged_files: { type: 'array', items: { type: 'string' } },
                changed_files: { type: 'array', items: { type: 'string' } },
                files_touched: { type: 'array', items: { type: 'string' } },
                checkout_from: { type: 'string' },
                checkout_to: { type: 'string' },
                checkout_is_branch: { type: 'boolean' },
                push_remote: { type: 'string' },
                push_url: { type: 'string' }
              }
            }
          }
        }
      },
      {
        name: 'tr_auto_checkpoint',
        description: 'Run automation decision + packet builder + checkpoint write in one MCP call.',
        inputSchema: {
          type: 'object',
          required: ['project'],
          properties: {
            project: { type: 'string' },
            trigger: { type: 'string' },
            phase: { type: 'string', enum: ['pre', 'post'] },
            mode: { type: 'string', enum: ['ephemeral', 'project', 'pinned'] },
            idempotency_key: { type: 'string' },
            signal: {
              type: 'object',
              properties: {
                force: { type: 'boolean' },
                reminder_due: { type: 'boolean' },
                repo_fingerprint_changed: { type: 'boolean' }
              }
            },
            repo_state: {
              type: 'object',
              properties: {
                project: { type: 'string' },
                branch: { type: 'string' },
                latest_commit: { type: 'string' },
                latest_subject: { type: 'string' },
                staged_count: { type: 'number' },
                changed_count: { type: 'number' },
                staged_files: { type: 'array', items: { type: 'string' } },
                changed_files: { type: 'array', items: { type: 'string' } },
                files_touched: { type: 'array', items: { type: 'string' } },
                checkout_from: { type: 'string' },
                checkout_to: { type: 'string' },
                checkout_is_branch: { type: 'boolean' },
                push_remote: { type: 'string' },
                push_url: { type: 'string' }
              }
            }
          }
        }
      },
      {
        name: 'tr_timeline',
        description: 'Return recent timestamped project checkpoint events.',
        inputSchema: {
          type: 'object',
          required: ['project'],
          properties: {
            project: { type: 'string' },
            limit: { type: 'number' },
            since: { type: 'string' },
            until: { type: 'string' }
          }
        }
      },
      {
        name: 'tr_projects',
        description: 'List recent projects and suggest best project for this workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
            workspace_hint: { type: 'string' }
          }
        }
      },
      {
        name: 'tr_search_checkpoints',
        description: 'Search checkpoints by keyword across one project or all projects.',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            project: { type: 'string' },
            limit: { type: 'number' },
            since: { type: 'string' },
            until: { type: 'string' }
          }
        }
      },
      {
        name: 'tr_blockers',
        description: 'Return unresolved blockers with lifecycle timestamps.',
        inputSchema: {
          type: 'object',
          required: ['project'],
          properties: {
            project: { type: 'string' }
          }
        }
      },
      {
        name: 'tr_graph_view',
        description: 'Return scoped graph snapshot (nodes and edges) for a project.',
        inputSchema: {
          type: 'object',
          required: ['project'],
          properties: {
            project: { type: 'string' },
            depth: { type: 'number' },
            limit: { type: 'number' },
            status: { type: 'string', enum: ['active', 'resolved', 'all'] },
            node_types: { type: 'array', items: { type: 'string' } },
            edge_types: { type: 'array', items: { type: 'string' } },
            since: { type: 'string' }
          }
        }
      },
      {
        name: 'tr_graph_diff',
        description: 'Return graph lifecycle delta between the latest two checkpoints.',
        inputSchema: {
          type: 'object',
          required: ['project'],
          properties: {
            project: { type: 'string' }
          }
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const { subject, tenant } = getAuthIdentity(args);
      if (name === 'tr_checkpoint') {
        const project = requiredProject(args);
        return asToolResult(await createCheckpoint({
          tenant,
          subject,
          project,
          mode: String(args?.mode || 'ephemeral'),
          idempotencyKey: String(args?.idempotency_key || '').trim(),
          workPacket: args?.work_packet || {},
          source: 'mcp'
        }));
      }
      if (name === 'tr_resume') {
        const project = requiredProject(args);
        return asToolResult(await getResume({
          tenant,
          subject,
          project,
          includeTiRefs: args?.include_ti_refs !== false,
          historyLimit: args?.history_limit
        }));
      }
      if (name === 'tr_timeline') {
        const project = requiredProject(args);
        return asToolResult(await getTimeline({
          tenant,
          subject,
          project,
          limit: args?.limit,
          since: args?.since,
          until: args?.until
        }));
      }
      if (name === 'tr_projects') {
        return asToolResult(await getProjects({
          tenant,
          subject,
          limit: args?.limit,
          workspaceHint: args?.workspace_hint
        }));
      }
      if (name === 'tr_search_checkpoints') {
        return asToolResult(await searchCheckpoints({
          tenant,
          subject,
          query: args?.query,
          project: args?.project,
          limit: args?.limit,
          since: args?.since,
          until: args?.until
        }));
      }
      if (name === 'tr_workflow_policy') {
        return asToolResult({
          ok: true,
          policy: workflowPolicy()
        });
      }
      if (name === 'tr_status') {
        const system = await getSystemStatus();
        const scoped = await getScopeStatus({
          tenant,
          subject,
          project: args?.project
        });
        return asToolResult({
          ok: true,
          system,
          scoped
        });
      }
      if (name === 'tr_auto_should_checkpoint') {
        const project = requiredProject(args);
        const trigger = normalizeAutoTrigger(args?.trigger || '');
        const signal = args?.signal && typeof args.signal === 'object' ? { ...args.signal } : {};
        if (typeof signal.reminder_due !== 'boolean' && trigger === 'stale-interval') {
          const scoped = await getScopeStatus({ tenant, subject, project });
          signal.reminder_due = Boolean(scoped?.reminder_due);
        }
        return asToolResult({
          ok: true,
          project,
          decision: decideAutoCheckpoint({ trigger, signal })
        });
      }
      if (name === 'tr_auto_work_packet') {
        const project = requiredProject(args);
        const trigger = normalizeAutoTrigger(args?.trigger || '');
        const phase = String(args?.phase || 'post').toLowerCase() === 'pre' ? 'pre' : 'post';
        const mode = String(args?.mode || 'project');
        const repoState = args?.repo_state && typeof args.repo_state === 'object' ? args.repo_state : {};
        return asToolResult({
          ok: true,
          project,
          trigger,
          phase,
          work_packet: buildAutoWorkPacket({
            trigger,
            phase,
            mode,
            repoState: { ...repoState, project },
            fallbackProject: project
          })
        });
      }
      if (name === 'tr_auto_checkpoint') {
        const project = requiredProject(args);
        const trigger = normalizeAutoTrigger(args?.trigger || '');
        const phase = String(args?.phase || 'post').toLowerCase() === 'pre' ? 'pre' : 'post';
        const mode = String(args?.mode || 'project');
        const signal = args?.signal && typeof args.signal === 'object' ? { ...args.signal } : {};
        if (typeof signal.reminder_due !== 'boolean' && trigger === 'stale-interval') {
          const scoped = await getScopeStatus({ tenant, subject, project });
          signal.reminder_due = Boolean(scoped?.reminder_due);
        }
        const decision = decideAutoCheckpoint({ trigger, signal });
        if (!decision.should_checkpoint) {
          return asToolResult({
            ok: true,
            project,
            trigger,
            phase,
            skipped: true,
            decision
          });
        }
        const repoState = args?.repo_state && typeof args.repo_state === 'object' ? args.repo_state : {};
        const workPacket = buildAutoWorkPacket({
          trigger,
          phase,
          mode,
          repoState: { ...repoState, project },
          fallbackProject: project
        });
        const checkpoint = await createCheckpoint({
          tenant,
          subject,
          project,
          mode,
          idempotencyKey: String(args?.idempotency_key || '').trim(),
          workPacket,
          source: 'mcp_auto'
        });
        return asToolResult({
          ok: true,
          project,
          trigger,
          phase,
          skipped: false,
          decision,
          checkpoint
        });
      }
      if (name === 'tr_blockers') {
        const project = requiredProject(args);
        return asToolResult(await getBlockers({ tenant, subject, project }));
      }
      if (name === 'tr_graph_view') {
        const project = requiredProject(args);
        return asToolResult(await getGraphView({
          tenant,
          subject,
          project,
          depth: args?.depth,
          limit: args?.limit,
          status: args?.status,
          nodeTypes: args?.node_types,
          edgeTypes: args?.edge_types,
          since: args?.since
        }));
      }
      if (name === 'tr_graph_diff') {
        const project = requiredProject(args);
        return asToolResult(await getGraphDiff({ tenant, subject, project }));
      }
      return asToolResult(asErrorPayload({ code: 'unknown_tool', message: `Unknown tool: ${name}` }));
    } catch (error) {
      return asToolResult(asErrorPayload(error));
    }
  });

  return server;
}
