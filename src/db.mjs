import crypto from 'node:crypto';
import { Pool } from 'pg';
import { config } from './config.mjs';

const pool = new Pool({
  connectionString: config.databaseUrl
});

function hashPayload(value) {
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
}

function normalizeBlockers(value) {
  const list = normalizeStringArray(value);
  return list.map((item) => ({
    title: item,
    status: 'open',
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    resolved_at: null
  }));
}

function makeNodeCompositeKey(nodeType, nodeKey) {
  return `${nodeType}::${nodeKey}`;
}

function normalizeIdentityKey(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function parseIsoTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`Invalid timestamp: ${raw}`);
    error.code = 'invalid_timestamp';
    throw error;
  }
  return date.toISOString();
}

function normalizeWorkspaceKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '');
}

function basenameFromWorkspaceHint(workspaceHint) {
  const normalized = normalizeWorkspaceKey(workspaceHint);
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

function buildGraphMaterialization({ project, mode, event, normalizedWorkPacket }) {
  const nodes = [];
  const edges = [];
  const seenNodes = new Set();
  const seenEdges = new Set();

  const addNode = (nodeType, nodeKey, props = {}) => {
    const key = makeNodeCompositeKey(nodeType, nodeKey);
    if (seenNodes.has(key)) return;
    seenNodes.add(key);
    nodes.push({
      node_type: nodeType,
      node_key: String(nodeKey),
      props
    });
  };

  const addEdge = (fromType, fromKey, toType, toKey, edgeType, props = {}) => {
    const edgeKey = `${fromType}:${fromKey}->${toType}:${toKey}:${edgeType}`;
    if (seenEdges.has(edgeKey)) return;
    seenEdges.add(edgeKey);
    edges.push({
      from_type: fromType,
      from_key: String(fromKey),
      to_type: toType,
      to_key: String(toKey),
      edge_type: edgeType,
      props
    });
  };

  const projectKey = project;
  const checkpointKey = event.id;
  addNode('Project', projectKey, { project, mode });
  addNode('Checkpoint', checkpointKey, {
    event_id: event.id,
    event_seq: Number(event.event_seq),
    current_goal: normalizedWorkPacket.current_goal,
    context_capsule: normalizedWorkPacket.context_capsule,
    handoff_notes: normalizedWorkPacket.handoff_notes,
    created_at: event.created_at,
    mode
  });
  addEdge('Project', projectKey, 'Checkpoint', checkpointKey, 'HAS_CHECKPOINT', {
    event_seq: Number(event.event_seq)
  });

  for (const decision of normalizedWorkPacket.decisions || []) {
    const key = normalizeIdentityKey(decision);
    addNode('Decision', key, { text: decision });
    addEdge('Checkpoint', checkpointKey, 'Decision', key, 'DECIDED');
  }

  for (const blocker of normalizedWorkPacket.blockers || []) {
    const key = normalizeIdentityKey(blocker);
    addNode('Blocker', key, { title: blocker });
    addEdge('Checkpoint', checkpointKey, 'Blocker', key, 'BLOCKED_BY');
  }

  for (const task of normalizedWorkPacket.next_actions || []) {
    const key = normalizeIdentityKey(task);
    addNode('Task', key, { title: task });
    addEdge('Checkpoint', checkpointKey, 'Task', key, 'NEXT_ACTION');
  }

  for (const filePath of normalizedWorkPacket.files_touched || []) {
    const key = normalizeIdentityKey(filePath);
    addNode('FileRef', key, { path: filePath });
    addEdge('Checkpoint', checkpointKey, 'FileRef', key, 'TOUCHED');
  }

  return { nodes, edges };
}

async function upsertGraphMaterialization(client, {
  tenant,
  subject,
  project,
  mode,
  event,
  normalizedWorkPacket
}) {
  const materialized = buildGraphMaterialization({
    project,
    mode,
    event,
    normalizedWorkPacket
  });
  const nodeIdByComposite = new Map();

  for (const node of materialized.nodes) {
    const result = await client.query(
      `insert into tr_nodes
      (tenant, subject, project, node_type, node_key, props, status, first_seen_at, last_seen_at, resolved_at)
      values ($1, $2, $3, $4, $5, $6::jsonb, 'active', $7, $7, null)
      on conflict (tenant, subject, project, node_type, node_key)
      do update set
        props = excluded.props,
        status = 'active',
        last_seen_at = excluded.last_seen_at,
        resolved_at = null
      returning id`,
      [
        tenant,
        subject,
        project,
        node.node_type,
        node.node_key,
        JSON.stringify(node.props || {}),
        event.created_at
      ]
    );
    nodeIdByComposite.set(makeNodeCompositeKey(node.node_type, node.node_key), result.rows[0].id);
  }

  for (const edge of materialized.edges) {
    const fromId = nodeIdByComposite.get(makeNodeCompositeKey(edge.from_type, edge.from_key));
    const toId = nodeIdByComposite.get(makeNodeCompositeKey(edge.to_type, edge.to_key));
    if (!fromId || !toId) continue;
    await client.query(
      `insert into tr_edges
      (tenant, subject, project, from_node_id, to_node_id, edge_type, props, status, first_seen_at, last_seen_at, resolved_at)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'active', $8, $8, null)
      on conflict (tenant, subject, project, from_node_id, to_node_id, edge_type)
      do update set
        props = excluded.props,
        status = 'active',
        last_seen_at = excluded.last_seen_at,
        resolved_at = null`,
      [
        tenant,
        subject,
        project,
        fromId,
        toId,
        edge.edge_type,
        JSON.stringify(edge.props || {}),
        event.created_at
      ]
    );
  }

  const activeBlockerKeys = new Set((normalizedWorkPacket.blockers || []).map((item) => normalizeIdentityKey(item)));
  const activeTaskKeys = new Set((normalizedWorkPacket.next_actions || []).map((item) => normalizeIdentityKey(item)));

  const activeLifecycleNodes = await client.query(
    `select id, node_type, node_key
       from tr_nodes
      where tenant = $1
        and subject = $2
        and project = $3
        and node_type in ('Blocker', 'Task')
        and status = 'active'`,
    [tenant, subject, project]
  );

  const nodesToResolve = [];
  for (const row of activeLifecycleNodes.rows) {
    if (row.node_type === 'Blocker' && !activeBlockerKeys.has(row.node_key)) {
      nodesToResolve.push(row.id);
    }
    if (row.node_type === 'Task' && !activeTaskKeys.has(row.node_key)) {
      nodesToResolve.push(row.id);
    }
  }

  if (nodesToResolve.length > 0) {
    await client.query(
      `update tr_nodes
          set status = 'resolved',
              resolved_at = coalesce(resolved_at, $4),
              last_seen_at = $4
        where tenant = $1
          and subject = $2
          and project = $3
          and id = any($5::uuid[])`,
      [tenant, subject, project, event.created_at, nodesToResolve]
    );

    await client.query(
      `update tr_edges
          set status = 'resolved',
              resolved_at = coalesce(resolved_at, $4),
              last_seen_at = $4
        where tenant = $1
          and subject = $2
          and project = $3
          and to_node_id = any($5::uuid[])
          and edge_type in ('BLOCKED_BY', 'NEXT_ACTION')
          and status = 'active'`,
      [tenant, subject, project, event.created_at, nodesToResolve]
    );
  }
}

export function sanitizeWorkPacket(input = {}) {
  const currentGoal = String(input.current_goal ?? '').trim();
  if (!currentGoal) {
    const error = new Error('work_packet.current_goal is required.');
    error.code = 'invalid_work_packet';
    throw error;
  }
  const contextCapsule = String(input.context_capsule ?? '').trim();
  if (!contextCapsule) {
    const error = new Error('work_packet.context_capsule is required.');
    error.code = 'invalid_work_packet';
    throw error;
  }

  const capped = (v, max = 2000) => String(v ?? '').slice(0, max).trim();
  const tiRefs = input.ti_refs && typeof input.ti_refs === 'object'
    ? {
        ti_session_id: capped(input.ti_refs.ti_session_id, 200),
        ti_run_id: capped(input.ti_refs.ti_run_id, 200),
        ti_last_question_hash: capped(input.ti_refs.ti_last_question_hash, 200)
      }
    : null;

  return {
    problem_statement: capped(input.problem_statement, 4000),
    current_goal: currentGoal,
    context_capsule: capped(contextCapsule, 8000),
    decision_rationale: capped(input.decision_rationale, 5000),
    implementation_notes: capped(input.implementation_notes, 5000),
    code_implementation_notes: capped(input.code_implementation_notes, 10000),
    code_refs: normalizeStringArray(input.code_refs).slice(0, 120),
    handoff_notes: capped(input.handoff_notes, 5000),
    in_progress: capped(input.in_progress, 3000),
    next_actions: normalizeStringArray(input.next_actions).slice(0, 30),
    blockers: normalizeStringArray(input.blockers).slice(0, 30),
    decisions: normalizeStringArray(input.decisions).slice(0, 30),
    tech_stack_hints: normalizeStringArray(input.tech_stack_hints).slice(0, 30),
    recurring_issues: normalizeStringArray(input.recurring_issues).slice(0, 30),
    code_patterns: normalizeStringArray(input.code_patterns).slice(0, 30),
    alternatives_rejected: normalizeStringArray(input.alternatives_rejected).slice(0, 30),
    constraints: normalizeStringArray(input.constraints).slice(0, 30),
    assumptions: normalizeStringArray(input.assumptions).slice(0, 30),
    files_touched: normalizeStringArray(input.files_touched).slice(0, 60),
    branch: capped(input.branch, 200),
    commit_sha: capped(input.commit_sha, 120),
    commit_subject: capped(input.commit_subject, 500),
    known_gaps: normalizeStringArray(input.known_gaps).slice(0, 30),
    ti_refs: tiRefs
  };
}

export async function healthCheck() {
  await pool.query('select 1');
}

export async function getSystemStatus() {
  const status = {
    ok: true,
    database: {
      connected: false
    },
    migrations: {
      table_present: false,
      applied_count: 0,
      applied_versions: [],
      last_applied_at: null
    },
    graph: {
      nodes_table_present: false,
      edges_table_present: false,
      nodes_count: 0,
      edges_count: 0
    }
  };

  const client = await pool.connect();
  try {
    await client.query('select 1');
    status.database.connected = true;

    const migrationTable = await client.query(`
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'tr_schema_migrations'
      ) as present
    `);
    const tablePresent = Boolean(migrationTable.rows[0]?.present);
    status.migrations.table_present = tablePresent;

    if (tablePresent) {
      const applied = await client.query(`
        select version, applied_at
        from tr_schema_migrations
        order by version asc
      `);
      status.migrations.applied_count = applied.rowCount;
      status.migrations.applied_versions = applied.rows.map((row) => row.version);
      status.migrations.last_applied_at = applied.rowCount > 0
        ? applied.rows[applied.rowCount - 1].applied_at
        : null;
    }

    const graphTables = await client.query(`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('tr_nodes', 'tr_edges')
    `);
    const tableNames = new Set(graphTables.rows.map((row) => row.table_name));
    status.graph.nodes_table_present = tableNames.has('tr_nodes');
    status.graph.edges_table_present = tableNames.has('tr_edges');

    if (status.graph.nodes_table_present) {
      const nodesCount = await client.query('select count(*)::bigint as total from tr_nodes');
      status.graph.nodes_count = Number(nodesCount.rows[0]?.total || 0);
    }
    if (status.graph.edges_table_present) {
      const edgesCount = await client.query('select count(*)::bigint as total from tr_edges');
      status.graph.edges_count = Number(edgesCount.rows[0]?.total || 0);
    }

    return status;
  } finally {
    client.release();
  }
}

export async function getScopeStatus({ tenant, subject, project = '' }) {
  const normalizedProject = String(project || '').trim();
  const params = [tenant, subject];
  let whereProject = '';
  if (normalizedProject) {
    params.push(normalizedProject);
    whereProject = ' and project = $3';
  }

  const eventsCountRes = await pool.query(
    `select count(*)::bigint as total
       from tr_events
      where tenant = $1 and subject = $2${whereProject}`,
    params
  );

  const stateRes = normalizedProject
    ? await pool.query(
      `select project, momentum_score, updated_at, last_activity_at, last_checkpoint_at
         from tr_project_state
        where tenant = $1 and subject = $2 and project = $3
        limit 1`,
      [tenant, subject, normalizedProject]
    )
    : await pool.query(
      `select project, momentum_score, updated_at, last_activity_at, last_checkpoint_at
         from tr_project_state
        where tenant = $1 and subject = $2
        order by updated_at desc
        limit 5`,
      [tenant, subject]
    );

  const thresholdMinutes = Math.max(1, Number(config.staleCheckpointMinutes || 20));
  const thresholdMs = thresholdMinutes * 60 * 1000;
  let reminder = null;
  if (normalizedProject) {
    if (stateRes.rowCount === 0) {
      reminder = {
        reminder_due: true,
        reason: 'no_checkpoint',
        threshold_minutes: thresholdMinutes,
        minutes_since_last_checkpoint: null,
        recommended_action: 'Call tr_checkpoint(project, work_packet) to establish baseline context.'
      };
    } else {
      const row = stateRes.rows[0];
      const lastCheckpointAt = row.last_checkpoint_at ? new Date(row.last_checkpoint_at) : null;
      const ageMs = lastCheckpointAt ? Date.now() - lastCheckpointAt.getTime() : Number.POSITIVE_INFINITY;
      const minutesSince = Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 60000)) : null;
      const due = !Number.isFinite(ageMs) || ageMs > thresholdMs;
      reminder = {
        reminder_due: due,
        reason: due ? 'stale_checkpoint' : 'fresh_checkpoint',
        threshold_minutes: thresholdMinutes,
        minutes_since_last_checkpoint: minutesSince,
        last_checkpoint_at: row.last_checkpoint_at || null,
        recommended_action: due
          ? 'Call tr_checkpoint with current_goal and context_capsule before continuing.'
          : null
      };
    }
  }

  const eventsTotal = Number(eventsCountRes.rows[0]?.total || 0);
  return {
    ok: true,
    scope: {
      tenant,
      subject,
      project: normalizedProject || null
    },
    events_total: eventsTotal,
    ...(normalizedProject && { project_checkpoint_count: eventsTotal }),
    recent_projects: stateRes.rows.map((row) => ({
      project: row.project,
      momentum_score: Number(row.momentum_score || 0),
      last_checkpoint_at: row.last_checkpoint_at || null,
      last_activity_at: row.last_activity_at,
      updated_at: row.updated_at
    })),
    reminder_due: Boolean(reminder?.reminder_due),
    reminder
  };
}

export async function createCheckpoint({
  tenant,
  subject,
  project,
  mode = 'ephemeral',
  workPacket,
  source = 'mcp',
  idempotencyKey = ''
}) {
  const nowIso = new Date().toISOString();
  const normalized = sanitizeWorkPacket(workPacket);
  const payload = {
    mode,
    checkpoint_window_start: nowIso,
    checkpoint_window_end: nowIso,
    work_packet: normalized
  };
  // Hash only stable checkpoint content; per-call window timestamps are always unique.
  const payloadHash = hashPayload({
    mode,
    work_packet: normalized
  });
  const lockKey = `${tenant}:${subject}:${project}`;

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [lockKey]);

    const normalizedIdempotencyKey = String(idempotencyKey || '').trim() || null;
    if (normalizedIdempotencyKey) {
      const existingByKey = await client.query(
        `select id, event_seq, created_at
           from tr_events
          where tenant = $1 and subject = $2 and project = $3 and idempotency_key = $4
          limit 1`,
        [tenant, subject, project, normalizedIdempotencyKey]
      );
      if (existingByKey.rowCount > 0) {
        const existing = existingByKey.rows[0];
        await client.query('commit');
        return {
          ok: true,
          event_id: existing.id,
          event_seq: Number(existing.event_seq),
          project,
          mode,
          created_at: existing.created_at,
          deduped: true,
          dedupe_reason: 'idempotency_key'
        };
      }
    }

    if (config.dedupeWindowSec > 0) {
      const existingByPayload = await client.query(
        `select id, event_seq, created_at
           from tr_events
          where tenant = $1
            and subject = $2
            and project = $3
            and payload_hash = $4
            and created_at >= (now() - make_interval(secs => $5))
          order by created_at desc
          limit 1`,
        [tenant, subject, project, payloadHash, config.dedupeWindowSec]
      );
      if (existingByPayload.rowCount > 0) {
        const existing = existingByPayload.rows[0];
        await client.query('commit');
        return {
          ok: true,
          event_id: existing.id,
          event_seq: Number(existing.event_seq),
          project,
          mode,
          created_at: existing.created_at,
          deduped: true,
          dedupe_reason: 'payload_hash_window'
        };
      }
    }

    const seqRes = await client.query(
      `select coalesce(max(event_seq), 0) + 1 as next_seq
         from tr_events
        where tenant = $1 and subject = $2 and project = $3`,
      [tenant, subject, project]
    );
    const eventSeq = Number(seqRes.rows[0].next_seq);

    const insertEvent = await client.query(
      `insert into tr_events
      (tenant, subject, project, event_type, event_seq, payload, payload_hash, source, idempotency_key)
      values ($1, $2, $3, 'checkpoint_created', $4, $5::jsonb, $6, $7, $8)
      returning id, created_at`,
      [
        tenant,
        subject,
        project,
        eventSeq,
        JSON.stringify(payload),
        payloadHash,
        source,
        normalizedIdempotencyKey
      ]
    );

    const event = insertEvent.rows[0];
    event.event_seq = eventSeq;
    const blockers = normalizeBlockers(normalized.blockers);
    const nextActions = normalized.next_actions;
    const momentumScore = Math.max(0, Math.min(100, (nextActions.length * 3) - (blockers.length * 2) + 50));

    await upsertGraphMaterialization(client, {
      tenant,
      subject,
      project,
      mode,
      event,
      normalizedWorkPacket: normalized
    });

    await client.query(
      `insert into tr_project_state
      (tenant, subject, project, latest_event_id, latest_checkpoint, open_blockers, next_actions, momentum_score, last_checkpoint_at, last_activity_at, updated_at)
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, now())
      on conflict (tenant, subject, project)
      do update set
        latest_event_id = excluded.latest_event_id,
        latest_checkpoint = excluded.latest_checkpoint,
        open_blockers = excluded.open_blockers,
        next_actions = excluded.next_actions,
        momentum_score = excluded.momentum_score,
        last_checkpoint_at = excluded.last_checkpoint_at,
        last_activity_at = excluded.last_activity_at,
        updated_at = now()`,
      [
        tenant,
        subject,
        project,
        event.id,
        JSON.stringify(normalized),
        JSON.stringify(blockers),
        JSON.stringify(nextActions),
        momentumScore,
        event.created_at,
        event.created_at
      ]
    );

    await client.query('commit');
    return {
      ok: true,
      event_id: event.id,
      event_seq: eventSeq,
      project,
      mode,
      created_at: event.created_at,
      deduped: false,
      dedupe_reason: null
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function getResume({ tenant, subject, project, includeTiRefs = true, historyLimit = 50 }) {
  const result = await pool.query(
    `select latest_event_id, latest_checkpoint, open_blockers, next_actions, momentum_score, last_checkpoint_at, last_activity_at, updated_at
       from tr_project_state
      where tenant = $1 and subject = $2 and project = $3`,
    [tenant, subject, project]
  );

  if (result.rowCount === 0) {
    const err = new Error(`No checkpoint found for project "${project}".`);
    err.code = 'not_found';
    throw err;
  }

  const row = result.rows[0];
  const checkpoint = row.latest_checkpoint || {};
  if (!includeTiRefs) checkpoint.ti_refs = null;
  const parsedHistoryLimit = Math.max(1, Math.min(Number(historyLimit) || 50, 500));
  const totalEventsResult = await pool.query(
    `select count(*)::int as total
       from tr_events
      where tenant = $1 and subject = $2 and project = $3`,
    [tenant, subject, project]
  );
  const historyResult = await pool.query(
    `select id, event_seq, payload, created_at
       from tr_events
      where tenant = $1 and subject = $2 and project = $3
      order by event_seq desc
      limit $4`,
    [tenant, subject, project, parsedHistoryLimit]
  );
  const continuityTrail = historyResult.rows.map((event) => {
    const workPacket = event.payload?.work_packet || {};
    return {
      event_id: event.id,
      event_seq: Number(event.event_seq),
      created_at: event.created_at,
      current_goal: String(workPacket.current_goal || '').trim(),
      context_capsule: String(workPacket.context_capsule || '').trim(),
      decisions: normalizeStringArray(workPacket.decisions).slice(0, 8),
      next_actions: normalizeStringArray(workPacket.next_actions).slice(0, 8),
      blockers: normalizeStringArray(workPacket.blockers).slice(0, 8),
      code_refs: normalizeStringArray(workPacket.code_refs).slice(0, 12)
    };
  });
  const thresholdMinutes = Math.max(1, Number(config.staleCheckpointMinutes || 20));
  const thresholdMs = thresholdMinutes * 60 * 1000;
  const lastCheckpointAt = row.last_checkpoint_at ? new Date(row.last_checkpoint_at) : null;
  const ageMs = lastCheckpointAt ? Date.now() - lastCheckpointAt.getTime() : Number.POSITIVE_INFINITY;
  const hasCheckpointTimestamp = Number.isFinite(ageMs);
  const isStale = !hasCheckpointTimestamp || ageMs > thresholdMs;
  const staleSinceHours = hasCheckpointTimestamp
    ? Number((Math.max(0, ageMs) / 3600000).toFixed(2))
    : null;
  const freshness = !hasCheckpointTimestamp
    ? 'no_checkpoint'
    : (isStale ? 'stale' : 'fresh');
  const confidence = freshness === 'fresh'
    ? 'high'
    : (freshness === 'stale' ? 'medium' : 'low');
  const recommendation = freshness === 'fresh'
    ? 'Context is fresh. Continue current flow and checkpoint at the next milestone.'
    : (freshness === 'stale'
      ? 'Call tr_checkpoint with current_goal and context_capsule to refresh context before continuing.'
      : 'Call tr_checkpoint(project, work_packet) to establish baseline context.');
  const contextCapsule = String(checkpoint.context_capsule || '').trim();
  const decisionRationale = String(checkpoint.decision_rationale || '').trim();
  const nextActions = normalizeStringArray(checkpoint.next_actions || []);
  const decisions = normalizeStringArray(checkpoint.decisions || []);
  const thinSignals = [];
  if (contextCapsule.length < 80) thinSignals.push('context_capsule_too_short');
  if (!decisionRationale) thinSignals.push('missing_decision_rationale');
  if (decisions.length === 0) thinSignals.push('missing_decisions');
  if (nextActions.length === 0) thinSignals.push('missing_next_actions');
  const captureQuality = thinSignals.length === 0
    ? 'strong'
    : (thinSignals.length <= 2 ? 'medium' : 'thin');
  const qualityRecommendation = thinSignals.length === 0
    ? recommendation
    : `Add richer checkpoint detail: ${thinSignals.join(', ')}.`;
  const latestCheckpointSummary = {
    event_id: row.latest_event_id || null,
    created_at: row.last_checkpoint_at || null
  };

  return {
    ok: true,
    project,
    latest_checkpoint: latestCheckpointSummary,
    latest_created_at: row.last_checkpoint_at || null,
    context_pack: {
      ...checkpoint,
      open_blockers: row.open_blockers || [],
      next_actions: row.next_actions || [],
      ti_refs: includeTiRefs ? checkpoint.ti_refs || null : null,
      lineage: { latest_event_id: row.latest_event_id }
    },
    continuity: {
      present_event_id: row.latest_event_id,
      history_limit: parsedHistoryLimit,
      total_events: Number(totalEventsResult.rows[0]?.total || 0),
      has_more: Number(totalEventsResult.rows[0]?.total || 0) > continuityTrail.length,
      trail: continuityTrail
    },
    momentum_score: Number(row.momentum_score || 0),
    quality_hints: {
      freshness,
      confidence,
      stale_since_hours: staleSinceHours,
      threshold_minutes: thresholdMinutes,
      recommendation: qualityRecommendation,
      capture_quality: captureQuality,
      thin_signals: thinSignals
    },
    last_checkpoint_at: row.last_checkpoint_at,
    last_activity_at: row.last_activity_at,
    last_updated_at: row.updated_at
  };
}

export async function getTimeline({ tenant, subject, project, limit = 20, since = '', until = '' }) {
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const parsedSince = parseIsoTimestamp(since);
  const parsedUntil = parseIsoTimestamp(until);
  const params = [tenant, subject, project];
  const filters = [];
  if (parsedSince) {
    params.push(parsedSince);
    filters.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (parsedUntil) {
    params.push(parsedUntil);
    filters.push(`created_at <= $${params.length}::timestamptz`);
  }
  params.push(parsedLimit);
  const where = filters.length > 0 ? ` and ${filters.join(' and ')}` : '';
  const result = await pool.query(
    `select id, event_type, event_seq, payload, created_at
       from tr_events
      where tenant = $1 and subject = $2 and project = $3${where}
      order by event_seq desc
      limit $${params.length}`,
    params
  );

  return {
    ok: true,
    project,
    filters: {
      since: parsedSince,
      until: parsedUntil
    },
    events: result.rows.map((row) => ({
      event_id: row.id,
      event_type: row.event_type,
      event_seq: Number(row.event_seq),
      created_at: row.created_at,
      summary: row.payload?.work_packet?.current_goal || 'checkpoint_created'
    }))
  };
}

export async function getProjects({ tenant, subject, limit = 10, workspaceHint = '' }) {
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const result = await pool.query(
    `select
       s.project,
       s.momentum_score,
       s.last_checkpoint_at,
       s.last_activity_at,
       s.updated_at,
       (
         select count(*)::int
           from tr_events e
          where e.tenant = s.tenant
            and e.subject = s.subject
            and e.project = s.project
       ) as event_count
     from tr_project_state s
     where s.tenant = $1 and s.subject = $2
     order by s.updated_at desc
     limit $3`,
    [tenant, subject, parsedLimit]
  );
  const normalizedHint = normalizeWorkspaceKey(workspaceHint);
  const hintBase = basenameFromWorkspaceHint(workspaceHint);
  const projects = result.rows.map((row) => ({
    project: row.project,
    momentum_score: Number(row.momentum_score || 0),
    event_count: Number(row.event_count || 0),
    last_checkpoint_at: row.last_checkpoint_at || null,
    last_activity_at: row.last_activity_at || null,
    updated_at: row.updated_at || null
  }));
  let suggestedProject = null;
  if (projects.length > 0) {
    const exact = projects.find((item) => normalizeWorkspaceKey(item.project) === normalizedHint);
    const baseMatch = hintBase
      ? projects.find((item) => normalizeWorkspaceKey(item.project).includes(hintBase))
      : null;
    suggestedProject = exact?.project || baseMatch?.project || projects[0].project;
  }
  return {
    ok: true,
    workspace_hint: workspaceHint || null,
    suggested_project: suggestedProject,
    projects
  };
}

export async function searchCheckpoints({
  tenant,
  subject,
  query,
  project = '',
  limit = 20,
  since = '',
  until = ''
}) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) {
    const err = new Error('query is required.');
    err.code = 'invalid_query';
    throw err;
  }
  const parsedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const parsedSince = parseIsoTimestamp(since);
  const parsedUntil = parseIsoTimestamp(until);
  const normalizedProject = String(project || '').trim();
  const params = [tenant, subject];
  const filters = ['tenant = $1', 'subject = $2'];
  if (normalizedProject) {
    params.push(normalizedProject);
    filters.push(`project = $${params.length}`);
  }
  params.push(`%${normalizedQuery}%`);
  const queryParam = params.length;
  filters.push(
    `(payload::text ilike $${queryParam} or project ilike $${queryParam})`
  );
  if (parsedSince) {
    params.push(parsedSince);
    filters.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (parsedUntil) {
    params.push(parsedUntil);
    filters.push(`created_at <= $${params.length}::timestamptz`);
  }
  params.push(parsedLimit);
  const where = filters.length > 0 ? `where ${filters.join(' and ')}` : '';
  const result = await pool.query(
    `select project, id, event_seq, event_type, created_at, payload
       from tr_events
      ${where}
      order by created_at desc
      limit $${params.length}`,
    params
  );
  return {
    ok: true,
    query: normalizedQuery,
    project: normalizedProject || null,
    filters: {
      since: parsedSince,
      until: parsedUntil
    },
    matches: result.rows.map((row) => ({
      project: row.project,
      event_id: row.id,
      event_seq: Number(row.event_seq),
      event_type: row.event_type,
      created_at: row.created_at,
      current_goal: String(row.payload?.work_packet?.current_goal || '').trim(),
      context_capsule: String(row.payload?.work_packet?.context_capsule || '').trim(),
      commit_sha: String(row.payload?.work_packet?.commit_sha || '').trim(),
      commit_subject: String(row.payload?.work_packet?.commit_subject || '').trim(),
      files_touched: normalizeStringArray(row.payload?.work_packet?.files_touched || []).slice(0, 20)
    }))
  };
}

export async function getBlockers({ tenant, subject, project }) {
  const result = await pool.query(
    `select open_blockers, updated_at
       from tr_project_state
      where tenant = $1 and subject = $2 and project = $3`,
    [tenant, subject, project]
  );
  if (result.rowCount === 0) {
    const err = new Error(`No checkpoint found for project "${project}".`);
    err.code = 'not_found';
    throw err;
  }
  return {
    ok: true,
    project,
    open_blockers: result.rows[0].open_blockers || [],
    last_updated_at: result.rows[0].updated_at
  };
}

function normalizeFilterList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function parseGraphStatus(status) {
  const normalized = String(status || 'active').trim().toLowerCase();
  if (normalized === 'active' || normalized === 'resolved' || normalized === 'all') {
    return normalized;
  }
  return 'active';
}

export async function getGraphView({
  tenant,
  subject,
  project,
  depth = 1,
  limit = 200,
  status = 'active',
  nodeTypes = [],
  edgeTypes = [],
  since = ''
}) {
  const parsedDepth = Math.max(1, Math.min(Number(depth) || 1, 3));
  const parsedLimit = Math.max(10, Math.min(Number(limit) || 200, 500));
  const parsedStatus = parseGraphStatus(status);
  const parsedNodeTypes = normalizeFilterList(nodeTypes);
  const parsedEdgeTypes = normalizeFilterList(edgeTypes);
  const parsedSince = String(since || '').trim();
  const sinceDate = parsedSince ? new Date(parsedSince) : null;
  const hasSince = Boolean(sinceDate && !Number.isNaN(sinceDate.getTime()));

  const latestEvent = await pool.query(
    `select latest_event_id
       from tr_project_state
      where tenant = $1 and subject = $2 and project = $3
      limit 1`,
    [tenant, subject, project]
  );

  const projectNode = await pool.query(
    `select id
       from tr_nodes
      where tenant = $1 and subject = $2 and project = $3 and node_type = 'Project' and node_key = $3
      limit 1`,
    [tenant, subject, project]
  );

  const seedIds = new Set();
  if (projectNode.rowCount > 0) {
    seedIds.add(projectNode.rows[0].id);
  }
  const latestEventId = latestEvent.rows[0]?.latest_event_id;
  if (latestEventId) {
    const checkpointNode = await pool.query(
      `select id
         from tr_nodes
        where tenant = $1 and subject = $2 and project = $3 and node_type = 'Checkpoint' and node_key = $4
        limit 1`,
      [tenant, subject, project, String(latestEventId)]
    );
    if (checkpointNode.rowCount > 0) {
      seedIds.add(checkpointNode.rows[0].id);
    }
  }

  if (seedIds.size === 0) {
    const params = [tenant, subject, project];
    let where = '';
    if (parsedStatus !== 'all') {
      params.push(parsedStatus);
      where += ` and status = $${params.length}`;
    }
    if (parsedNodeTypes.length > 0) {
      params.push(parsedNodeTypes);
      where += ` and node_type = any($${params.length}::text[])`;
    }
    if (hasSince) {
      params.push(sinceDate.toISOString());
      where += ` and last_seen_at >= $${params.length}::timestamptz`;
    }
    params.push(parsedLimit);
    const fallbackNodes = await pool.query(
      `select id, node_type, node_key, props, status, first_seen_at, last_seen_at, resolved_at
         from tr_nodes
        where tenant = $1 and subject = $2 and project = $3
         ${where}
        order by last_seen_at desc
        limit $${params.length}`,
      params
    );
    return {
      ok: true,
      project,
      depth: parsedDepth,
      filters: {
        status: parsedStatus,
        node_types: parsedNodeTypes,
        edge_types: parsedEdgeTypes,
        since: hasSince ? sinceDate.toISOString() : null
      },
      nodes: fallbackNodes.rows.map((row) => ({
        id: row.id,
        node_type: row.node_type,
        node_key: row.node_key,
        props: row.props || {},
        status: row.status,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        resolved_at: row.resolved_at
      })),
      edges: []
    };
  }

  const visited = new Set(seedIds);
  let frontier = Array.from(seedIds);
  const edgeMap = new Map();

  for (let step = 0; step < parsedDepth; step += 1) {
    if (frontier.length === 0 || visited.size >= parsedLimit) break;
    const edgeParams = [tenant, subject, project, frontier, parsedLimit];
    const edgesRes = await pool.query(
      `select id, from_node_id, to_node_id, edge_type, props, status, first_seen_at, last_seen_at, resolved_at
         from tr_edges
        where tenant = $1
          and subject = $2
          and project = $3
          and (from_node_id = any($4::uuid[]) or to_node_id = any($4::uuid[]))
        order by last_seen_at desc
        limit $5`,
      edgeParams
    );

    const nextFrontierSet = new Set();
    for (const edge of edgesRes.rows) {
      edgeMap.set(edge.id, edge);
      if (!visited.has(edge.from_node_id) && visited.size < parsedLimit) {
        visited.add(edge.from_node_id);
        nextFrontierSet.add(edge.from_node_id);
      }
      if (!visited.has(edge.to_node_id) && visited.size < parsedLimit) {
        visited.add(edge.to_node_id);
        nextFrontierSet.add(edge.to_node_id);
      }
    }
    frontier = Array.from(nextFrontierSet);
  }

  const nodeIds = Array.from(visited);
  const nodesRes = await pool.query(
    `select id, node_type, node_key, props, status, first_seen_at, last_seen_at, resolved_at
       from tr_nodes
      where tenant = $1
        and subject = $2
        and project = $3
        and id = any($4::uuid[])
      order by last_seen_at desc`,
    [tenant, subject, project, nodeIds]
  );

  const nodePasses = (node) => {
    if (parsedStatus !== 'all' && node.status !== parsedStatus) return false;
    if (parsedNodeTypes.length > 0 && !parsedNodeTypes.includes(node.node_type)) return false;
    if (hasSince && new Date(node.last_seen_at).getTime() < sinceDate.getTime()) return false;
    return true;
  };

  const edgePasses = (edge) => {
    if (parsedStatus !== 'all' && edge.status !== parsedStatus) return false;
    if (parsedEdgeTypes.length > 0 && !parsedEdgeTypes.includes(edge.edge_type)) return false;
    if (hasSince && new Date(edge.last_seen_at).getTime() < sinceDate.getTime()) return false;
    return true;
  };

  const filteredNodeRows = nodesRes.rows.filter(nodePasses);
  const includedNodeIds = new Set(filteredNodeRows.map((row) => row.id));
  const filteredEdges = Array.from(edgeMap.values()).filter((edge) => (
    edgePasses(edge) &&
    includedNodeIds.has(edge.from_node_id) &&
    includedNodeIds.has(edge.to_node_id)
  ));

  return {
    ok: true,
    project,
    depth: parsedDepth,
    filters: {
      status: parsedStatus,
      node_types: parsedNodeTypes,
      edge_types: parsedEdgeTypes,
      since: hasSince ? sinceDate.toISOString() : null
    },
    nodes: filteredNodeRows.map((row) => ({
      id: row.id,
      node_type: row.node_type,
      node_key: row.node_key,
      props: row.props || {},
      status: row.status,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      resolved_at: row.resolved_at
    })),
    edges: filteredEdges.map((edge) => ({
      id: edge.id,
      from_node_id: edge.from_node_id,
      to_node_id: edge.to_node_id,
      edge_type: edge.edge_type,
      props: edge.props || {},
      status: edge.status,
      first_seen_at: edge.first_seen_at,
      last_seen_at: edge.last_seen_at,
      resolved_at: edge.resolved_at
    }))
  };
}

export async function getGraphDiff({ tenant, subject, project }) {
  const checkpointEvents = await pool.query(
    `select id, event_seq, created_at
       from tr_events
      where tenant = $1 and subject = $2 and project = $3 and event_type = 'checkpoint_created'
      order by event_seq desc
      limit 2`,
    [tenant, subject, project]
  );

  if (checkpointEvents.rowCount === 0) {
    return {
      ok: true,
      project,
      latest_event_id: null,
      previous_event_id: null,
      changes: {
        new_nodes: [],
        resolved_nodes: [],
        unchanged_nodes: []
      }
    };
  }

  const latest = checkpointEvents.rows[0];
  const previous = checkpointEvents.rows[1] || null;

  const latestGraph = await getGraphView({
    tenant,
    subject,
    project,
    depth: 2,
    limit: 500,
    status: 'all'
  });

  const nodeLabel = (node) => {
    if (node.node_type === 'Decision') return node.props?.text || node.node_key;
    if (node.node_type === 'Blocker') return node.props?.title || node.node_key;
    if (node.node_type === 'Task') return node.props?.title || node.node_key;
    if (node.node_type === 'FileRef') return node.props?.path || node.node_key;
    return node.node_key;
  };

  const relevantNodes = (latestGraph.nodes || []).filter((node) => (
    node.node_type === 'Decision' ||
    node.node_type === 'Blocker' ||
    node.node_type === 'Task' ||
    node.node_type === 'FileRef'
  ));

  const previousCreatedAt = previous?.created_at ? new Date(previous.created_at) : null;
  const latestCreatedAt = latest?.created_at ? new Date(latest.created_at) : null;

  const newNodes = [];
  const resolvedNodes = [];
  const unchangedNodes = [];

  for (const node of relevantNodes) {
    const firstSeen = node.first_seen_at ? new Date(node.first_seen_at) : null;
    const resolvedAt = node.resolved_at ? new Date(node.resolved_at) : null;
    const summary = {
      node_type: node.node_type,
      node_key: node.node_key,
      label: nodeLabel(node),
      status: node.status,
      first_seen_at: node.first_seen_at,
      last_seen_at: node.last_seen_at,
      resolved_at: node.resolved_at
    };

    if (
      firstSeen &&
      (
        (!previousCreatedAt && latestCreatedAt && firstSeen.getTime() >= latestCreatedAt.getTime()) ||
        (previousCreatedAt && firstSeen.getTime() > previousCreatedAt.getTime() &&
          (!latestCreatedAt || firstSeen.getTime() <= latestCreatedAt.getTime()))
      )
    ) {
      newNodes.push(summary);
      continue;
    }

    if (
      resolvedAt &&
      (
        (!previousCreatedAt && !latestCreatedAt) ||
        (!previousCreatedAt && latestCreatedAt && resolvedAt.getTime() <= latestCreatedAt.getTime()) ||
        (previousCreatedAt && resolvedAt.getTime() >= previousCreatedAt.getTime() &&
          (!latestCreatedAt || resolvedAt.getTime() <= latestCreatedAt.getTime()))
      )
    ) {
      resolvedNodes.push(summary);
      continue;
    }

    if (previousCreatedAt && firstSeen && firstSeen.getTime() <= previousCreatedAt.getTime()) {
      unchangedNodes.push(summary);
      continue;
    }

    if (!previousCreatedAt) {
      newNodes.push(summary);
      continue;
    }

    unchangedNodes.push(summary);
  }

  return {
    ok: true,
    project,
    latest_event_id: latest.id,
    previous_event_id: previous?.id || null,
    changes: {
      new_nodes: newNodes,
      resolved_nodes: resolvedNodes,
      unchanged_nodes: unchangedNodes
    }
  };
}
