import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AgentRouterCandidate,
  AgentRouterPlanSpec,
  AgentRouterPlanStatus,
  AgentRouterResult,
  AgentRouterTaskResult,
  AgentRouterTaskStatus,
} from '@deep-worker/shared';
import { canWorkspaceAction } from '../workspace-acl.js';

export type Db = Database.Database;

export interface AgentBindingRow extends AgentRouterCandidate {
  workspaceJid: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRouterPlanRow {
  id: string;
  workspaceJid: string;
  sessionId: string | null;
  actorUserId: string;
  intent: string;
  status: AgentRouterPlanStatus;
  input: string;
  route: AgentRouterPlanSpec;
  result: AgentRouterResult | null;
  capabilityHash: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface PlanDbRow {
  id: string;
  workspace_jid: string;
  session_id: string | null;
  actor_user_id: string;
  intent: string;
  status: AgentRouterPlanStatus;
  input_json: string;
  route_json: string;
  result_json: string | null;
  capability_hash: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function parse<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function mapPlan(row: PlanDbRow): AgentRouterPlanRow {
  return {
    id: row.id,
    workspaceJid: row.workspace_jid,
    sessionId: row.session_id,
    actorUserId: row.actor_user_id,
    intent: row.intent,
    status: row.status,
    input: parse<{ message: string }>(row.input_json)?.message ?? '',
    route: parse<AgentRouterPlanSpec>(row.route_json) ?? { intent: row.intent, requiredCapabilities: [], tasks: [], fallback: 'reject', explanation: '' },
    result: parse<AgentRouterResult>(row.result_json),
    capabilityHash: row.capability_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function listAgentBindings(db: Db, actorUserId: string, workspaceJid: string): AgentBindingRow[] | undefined {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'view')) return undefined;
  const rows = db.prepare(
    `SELECT b.*, p.name AS profile_name
     FROM workspace_agent_bindings b JOIN agent_profiles p ON p.id = b.agent_profile_id
     WHERE b.workspace_jid = ? AND b.enabled = 1 AND p.status = 'active'
     ORDER BY b.priority DESC, b.display_name ASC`,
  ).all(workspaceJid) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    bindingId: String(row.id),
    agentProfileId: String(row.agent_profile_id),
    name: String(row.display_name || row.profile_name),
    capabilities: parse<string[]>(String(row.capability_json)) ?? [],
    roleTags: parse<string[]>(String(row.role_tags_json)) ?? [],
    priority: Number(row.priority) || 0,
    workspaceJid,
    enabled: row.enabled === 1,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export function createAgentBinding(
  db: Db,
  actorUserId: string,
  workspaceJid: string,
  input: { agentProfileId: string; displayName?: string; capabilities?: string[]; roleTags?: string[]; priority?: number },
): { ok: boolean; binding?: AgentBindingRow; reason?: 'forbidden' | 'profile_not_found' | 'duplicate' } {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'manage')) return { ok: false, reason: 'forbidden' };
  const profile = db.prepare('SELECT id, name, status FROM agent_profiles WHERE id = ?').get(input.agentProfileId) as { id: string; name: string; status: string } | undefined;
  if (!profile || profile.status !== 'active') return { ok: false, reason: 'profile_not_found' };
  const id = `wab_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO workspace_agent_bindings (
        id, workspace_jid, agent_profile_id, display_name, capability_json,
        role_tags_json, priority, enabled, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(id, workspaceJid, input.agentProfileId, input.displayName?.trim() || profile.name,
      JSON.stringify([...new Set(input.capabilities ?? [])].sort()),
      JSON.stringify([...new Set(input.roleTags ?? [])].sort()), input.priority ?? 0,
      actorUserId, now, now);
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) return { ok: false, reason: 'duplicate' };
    throw error;
  }
  return { ok: true, binding: listAgentBindings(db, actorUserId, workspaceJid)?.find((item) => item.bindingId === id) };
}

export function removeAgentBinding(db: Db, actorUserId: string, workspaceJid: string, bindingId: string): boolean {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'manage')) return false;
  return db.prepare('DELETE FROM workspace_agent_bindings WHERE id = ? AND workspace_jid = ?').run(bindingId, workspaceJid).changes === 1;
}

export function createRouterPlan(
  db: Db,
  actorUserId: string,
  workspaceJid: string,
  sessionId: string | null,
  input: string,
  route: AgentRouterPlanSpec,
  capabilityHash: string | null,
): AgentRouterPlanRow {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'converse')) throw new Error('Workspace not found');
  const id = `arp_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_router_plans (
        id, workspace_jid, session_id, actor_user_id, intent, status,
        input_json, route_json, capability_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?)`,
    ).run(id, workspaceJid, sessionId, actorUserId, route.intent, JSON.stringify({ message: input }), JSON.stringify(route), capabilityHash, now, now);
    const insert = db.prepare(
      `INSERT INTO agent_router_tasks (
        id, plan_id, ordinal, agent_binding_id, agent_profile_id, title,
        input_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    );
    for (const task of route.tasks) {
      insert.run(`art_${crypto.randomUUID()}`, id, task.ordinal, task.bindingId, task.agentProfileId, task.title, JSON.stringify(task), now, now);
    }
  })();
  return getRouterPlan(db, actorUserId, workspaceJid, id)!;
}

export function getRouterPlan(db: Db, actorUserId: string, workspaceJid: string, id: string): AgentRouterPlanRow | undefined {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'view')) return undefined;
  const row = db.prepare('SELECT * FROM agent_router_plans WHERE id = ? AND workspace_jid = ?').get(id, workspaceJid) as PlanDbRow | undefined;
  return row ? mapPlan(row) : undefined;
}

export function listRouterPlans(db: Db, actorUserId: string, workspaceJid: string): AgentRouterPlanRow[] | undefined {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'view')) return undefined;
  return (db.prepare('SELECT * FROM agent_router_plans WHERE workspace_jid = ? ORDER BY created_at DESC').all(workspaceJid) as PlanDbRow[]).map(mapPlan);
}

export function getRouterTasks(db: Db, actorUserId: string, workspaceJid: string, planId: string): AgentRouterTaskResult[] | undefined {
  if (!getRouterPlan(db, actorUserId, workspaceJid, planId)) return undefined;
  const rows = db.prepare(
    `SELECT t.id, t.ordinal, t.agent_profile_id, t.status, t.result_json, t.error
     FROM agent_router_tasks t JOIN agent_router_plans p ON p.id = t.plan_id
     WHERE t.plan_id = ? AND p.workspace_jid = ? ORDER BY t.ordinal`,
  ).all(planId, workspaceJid) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    taskId: String(row.id), ordinal: Number(row.ordinal), agentProfileId: String(row.agent_profile_id),
    status: String(row.status) as AgentRouterTaskStatus,
    text: parse<{ text?: string }>(String(row.result_json))?.text ?? null,
    ...(row.error ? { error: String(row.error) } : {}),
  }));
}

export function setRouterPlanStatus(db: Db, planId: string, status: AgentRouterPlanStatus, result?: AgentRouterResult): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE agent_router_plans SET status = ?, result_json = COALESCE(?, result_json), updated_at = ?, completed_at = CASE WHEN ? IN (\'completed\', \'failed\', \'cancelled\') THEN ? ELSE completed_at END WHERE id = ?')
    .run(status, result ? JSON.stringify(result) : null, now, status, now, planId);
}

export function setRouterTaskStatus(db: Db, taskId: string, status: AgentRouterTaskStatus, result?: { text?: string; error?: string }): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE agent_router_tasks SET status = ?, attempt = attempt + CASE WHEN ? = \'running\' THEN 1 ELSE 0 END, result_json = COALESCE(?, result_json), error = ?, updated_at = ?, completed_at = CASE WHEN ? IN (\'completed\', \'failed\', \'skipped\') THEN ? ELSE completed_at END WHERE id = ?')
    .run(status, status, result ? JSON.stringify(result) : null, result?.error ?? null, now, status, now, taskId);
}

export function appendRouterEvent(db: Db, planId: string, taskId: string | null, event: unknown): void {
  const row = db.prepare('SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM agent_router_events WHERE plan_id = ?').get(planId) as { ordinal: number };
  db.prepare('INSERT INTO agent_router_events (id, plan_id, task_id, ordinal, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`are_${crypto.randomUUID()}`, planId, taskId, row.ordinal + 1, JSON.stringify(event), new Date().toISOString());
}

export function listRouterEvents(db: Db, actorUserId: string, workspaceJid: string, planId: string): unknown[] | undefined {
  if (!getRouterPlan(db, actorUserId, workspaceJid, planId)) return undefined;
  return (db.prepare('SELECT event_json FROM agent_router_events WHERE plan_id = ? ORDER BY ordinal').all(planId) as Array<{ event_json: string }>).map((row) => parse<unknown>(row.event_json));
}
