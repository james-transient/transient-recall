import process from 'node:process';

const base = process.env.TR_BASE_URL || 'http://localhost:8090';
const mcpUrl = `${base}/mcp`;

async function post(payload, sessionId = '') {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream'
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return { headers: response.headers, body: text };
}

function print(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(value);
}

function parseSseJson(body) {
  const line = body
    .split('\n')
    .map((lineItem) => lineItem.trim())
    .find((lineItem) => lineItem.startsWith('data: '));
  if (!line) throw new Error(`Unexpected SSE payload: ${body}`);
  return JSON.parse(line.slice(6));
}

function parseToolTextPayload(body) {
  const sse = parseSseJson(body);
  const text = sse?.result?.content?.[0]?.text;
  if (!text) throw new Error(`Tool response missing text payload: ${body}`);
  return JSON.parse(text);
}

async function run() {
  const project = `TR-smoke-script-${Date.now()}`;
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tr-smoke', version: '0.1.0' }
    }
  });
  const sessionId = init.headers.get('mcp-session-id') || '';
  if (!sessionId) throw new Error('Missing mcp-session-id from initialize response.');
  print('SESSION', sessionId);

  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
  print('TOOLS', list.body);

  const checkpoint = await post({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'tr_checkpoint',
      arguments: {
        project,
        idempotency_key: `smoke-${Date.now()}`,
        work_packet: {
          problem_statement: 'Smoke test script run',
          current_goal: 'Validate TR MCP flow',
          context_capsule: 'AI summary: baseline checkpoint with active blockers, actions, and decision context.',
          decision_rationale: 'This checkpoint anchors current state before lifecycle transition test.',
          implementation_notes: 'Testing deterministic graph materialization and timeline continuity.',
          code_implementation_notes: 'Added checkpoint write path assertions and graph lifecycle reads in smoke harness.',
          code_refs: ['scripts/smoke-test.mjs::run()', 'src/db.mjs::getGraphView()'],
          tech_stack_hints: ['nodejs', 'mcp', 'postgresql'],
          recurring_issues: ['checkpoint cadence can drift during long sessions'],
          code_patterns: ['append-only events', 'checkpoint-driven handoff'],
          handoff_notes: 'Next checkpoint should resolve blockers/tasks and keep traceability.',
          in_progress: 'Running smoke script',
          next_actions: ['Resume project', 'Inspect timeline'],
          blockers: ['db migration lock'],
          decisions: ['Adopt append-only events'],
          files_touched: ['scripts/smoke-test.mjs', 'src/db.mjs'],
          known_gaps: ['auth strict mode not enabled'],
          ti_refs: { ti_session_id: 'ti-smoke-session' }
        }
      }
    }
  }, sessionId);
  print('CHECKPOINT', checkpoint.body);

  const checkpointDedup = await post({
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: {
      name: 'tr_checkpoint',
      arguments: {
        project,
        idempotency_key: 'smoke-fixed-idem',
        work_packet: {
          current_goal: 'Validate dedupe behavior',
          context_capsule: 'AI summary: ensure repeated idempotency key returns same checkpoint event.',
          tech_stack_hints: ['nodejs', 'mcp', 'postgresql'],
          recurring_issues: ['checkpoint cadence can drift during long sessions'],
          code_patterns: ['append-only events', 'checkpoint-driven handoff']
        }
      }
    }
  }, sessionId);
  print('CHECKPOINT_DEDUPE_FIRST', checkpointDedup.body);

  const checkpointDedupAgain = await post({
    jsonrpc: '2.0',
    id: 32,
    method: 'tools/call',
    params: {
      name: 'tr_checkpoint',
      arguments: {
        project,
        idempotency_key: 'smoke-fixed-idem',
        work_packet: {
          current_goal: 'Validate dedupe behavior',
          context_capsule: 'AI summary: repeat same request to validate idempotent dedupe result.',
          tech_stack_hints: ['nodejs', 'mcp', 'postgresql'],
          recurring_issues: ['checkpoint cadence can drift during long sessions'],
          code_patterns: ['append-only events', 'checkpoint-driven handoff']
        }
      }
    }
  }, sessionId);
  print('CHECKPOINT_DEDUPE_SECOND', checkpointDedupAgain.body);

  const policy = await post({
    jsonrpc: '2.0',
    id: 33,
    method: 'tools/call',
    params: {
      name: 'tr_workflow_policy',
      arguments: {}
    }
  }, sessionId);
  print('WORKFLOW_POLICY', policy.body);
  const policyPayload = parseToolTextPayload(policy.body);
  const dedupeWindowSeconds = Number(policyPayload?.policy?.data_minimization?.dedupe_window_seconds || 0);

  const status = await post({
    jsonrpc: '2.0',
    id: 34,
    method: 'tools/call',
    params: {
      name: 'tr_status',
      arguments: { project }
    }
  }, sessionId);
  print('STATUS', status.body);
  const statusPayload = parseToolTextPayload(status.body);
  const graph = statusPayload?.system?.graph || null;
  if (!graph?.nodes_table_present || !graph?.edges_table_present) {
    throw new Error('Graph tables are not present. Run npm run migrate and retry.');
  }
  if (!statusPayload?.scoped?.reminder || statusPayload.scoped.reminder_due !== false) {
    throw new Error('Expected fresh checkpoint reminder state after initial checkpoint.');
  }

  const resume = await post({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'tr_resume',
      arguments: {
        project,
        include_ti_refs: true
      }
    }
  }, sessionId);
  print('RESUME', resume.body);
  const resumePayload = parseToolTextPayload(resume.body);
  const qualityHints = resumePayload?.quality_hints;
  if (!qualityHints || typeof qualityHints !== 'object') {
    throw new Error('Resume missing quality_hints payload.');
  }
  if (!['fresh', 'stale', 'no_checkpoint'].includes(String(qualityHints.freshness || ''))) {
    throw new Error('Resume quality_hints.freshness has invalid value.');
  }
  if (!['high', 'medium', 'low'].includes(String(qualityHints.confidence || ''))) {
    throw new Error('Resume quality_hints.confidence has invalid value.');
  }
  if (qualityHints.freshness !== 'no_checkpoint' && typeof qualityHints.stale_since_hours !== 'number') {
    throw new Error('Resume quality_hints.stale_since_hours should be numeric when checkpoint exists.');
  }
  if (typeof qualityHints.threshold_minutes !== 'number' || qualityHints.threshold_minutes < 1) {
    throw new Error('Resume quality_hints.threshold_minutes should be >= 1.');
  }
  if (!String(qualityHints.recommendation || '').trim()) {
    throw new Error('Resume quality_hints.recommendation is required.');
  }
  const contextPack = resumePayload?.context_pack || {};
  const hasTechHint = Array.isArray(contextPack.tech_stack_hints) && contextPack.tech_stack_hints.includes('nodejs');
  const hasRecurringIssue = Array.isArray(contextPack.recurring_issues)
    && contextPack.recurring_issues.includes('checkpoint cadence can drift during long sessions');
  const hasCodePattern = Array.isArray(contextPack.code_patterns)
    && contextPack.code_patterns.includes('append-only events');
  if (!hasTechHint || !hasRecurringIssue || !hasCodePattern) {
    throw new Error('Resume context_pack missing richer capture fields from checkpoint.');
  }

  const timeline = await post({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'tr_timeline',
      arguments: { project, limit: 5 }
    }
  }, sessionId);
  print('TIMELINE', timeline.body);

  const checkpointLifecycle = await post({
    jsonrpc: '2.0',
    id: 51,
    method: 'tools/call',
    params: {
      name: 'tr_checkpoint',
      arguments: {
        project,
        idempotency_key: `smoke-life-${Date.now()}`,
        work_packet: {
          current_goal: 'Validate lifecycle resolution',
          context_capsule: 'AI summary: close prior blocker/task context and open new decision handoff.',
          decision_rationale: 'Lifecycle checkpoint verifies resolved states for blockers and tasks.',
          code_implementation_notes: 'Verified resolved node filters and graph diff lifecycle classification.',
          code_refs: ['src/db.mjs::getGraphDiff()', 'src/tr-mcp-core.mjs::tr_graph_diff'],
          handoff_notes: 'Resolved nodes should be visible in graph filters and diff output.',
          in_progress: 'Clearing blockers and tasks',
          next_actions: [],
          blockers: [],
          decisions: ['Keep append-only semantics'],
          files_touched: ['scripts/smoke-test.mjs']
        }
      }
    }
  }, sessionId);
  print('CHECKPOINT_LIFECYCLE', checkpointLifecycle.body);

  const graphView = await post({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'tr_graph_view',
      arguments: { project, depth: 2, limit: 200, status: 'active' }
    }
  }, sessionId);
  print('GRAPH_VIEW', graphView.body);
  const graphPayload = parseToolTextPayload(graphView.body);
  const nodeTypes = new Set((graphPayload?.nodes || []).map((node) => node.node_type));
  const edgeTypes = new Set((graphPayload?.edges || []).map((edge) => edge.edge_type));
  if (!nodeTypes.has('Decision')) {
    throw new Error('Graph view missing expected Decision nodes.');
  }
  if (!edgeTypes.has('DECIDED')) {
    throw new Error('Graph view missing expected DECIDED edges.');
  }

  const resolvedGraph = await post({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'tr_graph_view',
      arguments: {
        project,
        depth: 2,
        limit: 200,
        status: 'resolved',
        node_types: ['Checkpoint', 'Blocker', 'Task'],
        edge_types: ['BLOCKED_BY', 'NEXT_ACTION']
      }
    }
  }, sessionId);
  print('GRAPH_VIEW_RESOLVED', resolvedGraph.body);
  const resolvedPayload = parseToolTextPayload(resolvedGraph.body);
  const resolvedNodeTypes = new Set((resolvedPayload?.nodes || []).map((node) => node.node_type));
  if (!resolvedNodeTypes.has('Blocker') || !resolvedNodeTypes.has('Task')) {
    throw new Error('Resolved graph missing expected Blocker/Task nodes.');
  }

  const lifecycleEdges = await post({
    jsonrpc: '2.0',
    id: 71,
    method: 'tools/call',
    params: {
      name: 'tr_graph_view',
      arguments: {
        project,
        depth: 2,
        limit: 200,
        status: 'all',
        node_types: ['Checkpoint', 'Blocker', 'Task'],
        edge_types: ['BLOCKED_BY', 'NEXT_ACTION']
      }
    }
  }, sessionId);
  print('GRAPH_VIEW_LIFECYCLE_EDGES', lifecycleEdges.body);
  const lifecycleEdgesPayload = parseToolTextPayload(lifecycleEdges.body);
  const lifecycleEdgeTypes = new Set((lifecycleEdgesPayload?.edges || []).map((edge) => edge.edge_type));
  const lifecycleHasResolved = (lifecycleEdgesPayload?.edges || []).some((edge) => edge.status === 'resolved');
  if (!lifecycleEdgeTypes.has('BLOCKED_BY') || !lifecycleEdgeTypes.has('NEXT_ACTION')) {
    throw new Error('Lifecycle graph missing expected BLOCKED_BY/NEXT_ACTION edges.');
  }
  if (!lifecycleHasResolved) {
    throw new Error('Lifecycle graph missing resolved edge states.');
  }

  const graphDiff = await post({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'tr_graph_diff',
      arguments: { project }
    }
  }, sessionId);
  print('GRAPH_DIFF', graphDiff.body);
  const diffPayload = parseToolTextPayload(graphDiff.body);
  if (!Array.isArray(diffPayload?.changes?.resolved_nodes) || diffPayload.changes.resolved_nodes.length === 0) {
    throw new Error('Graph diff missing resolved_nodes after lifecycle checkpoint.');
  }

  // Regression: payload-hash dedupe should still run when idempotency_key is present
  // but does not match an existing event.
  const payloadHashProbePacket = {
    current_goal: 'Validate payload-hash dedupe with unmatched idempotency key',
    context_capsule: 'AI summary: identical payload sent under different idempotency keys.'
  };
  const payloadHashProbeA = await post({
    jsonrpc: '2.0',
    id: 35,
    method: 'tools/call',
    params: {
      name: 'tr_checkpoint',
      arguments: {
        project,
        idempotency_key: `smoke-payload-probe-a-${Date.now()}`,
        work_packet: payloadHashProbePacket
      }
    }
  }, sessionId);
  print('CHECKPOINT_PAYLOAD_HASH_PROBE_A', payloadHashProbeA.body);

  const payloadHashProbeB = await post({
    jsonrpc: '2.0',
    id: 36,
    method: 'tools/call',
    params: {
      name: 'tr_checkpoint',
      arguments: {
        project,
        idempotency_key: `smoke-payload-probe-b-${Date.now()}`,
        work_packet: payloadHashProbePacket
      }
    }
  }, sessionId);
  print('CHECKPOINT_PAYLOAD_HASH_PROBE_B', payloadHashProbeB.body);

  const payloadHashProbeAPayload = parseToolTextPayload(payloadHashProbeA.body);
  const payloadHashProbeBPayload = parseToolTextPayload(payloadHashProbeB.body);
  if (dedupeWindowSeconds > 0) {
    if (!payloadHashProbeBPayload?.deduped || payloadHashProbeBPayload?.dedupe_reason !== 'payload_hash_window') {
      throw new Error('Expected payload-hash dedupe with unmatched idempotency_key when dedupe window is enabled.');
    }
    if (payloadHashProbeAPayload?.event_id !== payloadHashProbeBPayload?.event_id) {
      throw new Error('Expected payload-hash dedupe to return the original event id.');
    }
  }
}

run().catch((error) => {
  console.error('\nSmoke test failed:', error.message);
  process.exit(1);
});
