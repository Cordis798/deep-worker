import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AgentRouterApprovalStatus,
  AgentRouterCandidate,
  AgentRouterPlanSpec,
  AgentRouterPlanStatus,
  AgentRouterResult,
  AgentRouterTaskResult,
  AgentRouterTaskSpec,
  AgentRouterTaskStatus,
} from '@deep-worker/shared';
import { canWorkspaceAction, getWorkspaceAccess } from '../workspace-acl.js';

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
  planHash: string | null;
  approvalRequired: boolean;
  approvalStatus: AgentRouterApprovalStatus;
  approvalExpiresAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface AgentRouterTaskRow {
  id: string;
  planId: string;
  spec: AgentRouterTaskSpec;
  status: AgentRouterTaskStatus;
  attempt: number;
  resultText: string | null;
  error: string | null;
}

export const DEFAULT_ROUTER_LEASE_MS = 5 * 60 * 1000;

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
  approval_required: number;
  approval_status: AgentRouterApprovalStatus;
  approval_expires_at: string | null;
  approval_hash: string | null;
  approved_by: string | null;
  approved_at: string | null;
}

function parse<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function mapPlan(row: PlanDbRow): AgentRouterPlanRow {
  const approvalStatus = row.approval_status ?? 'not_required';
  return {
    id: row.id,
    workspaceJid: row.workspace_jid,
    sessionId: row.session_id,
    actorUserId: row.actor_user_id,
    intent: row.intent,
    status: row.status === 'planned' && approvalStatus === 'pending' ? 'awaiting_approval' : row.status,
    input: parse<{ message: string }>(row.input_json)?.message ?? '',
    route: parse<AgentRouterPlanSpec>(row.route_json) ?? { intent: row.intent, requiredCapabilities: [], tasks: [], fallback: 'reject', explanation: '', risk: 'read' },
    result: parse<AgentRouterResult>(row.result_json),
    capabilityHash: row.capability_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    planHash: row.approval_hash,
    approvalRequired: row.approval_required === 1,
    approvalStatus,
    approvalExpiresAt: row.approval_expires_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

export const ROUTER_APPROVAL_TTL_MS = 10 * 60 * 1000;

function routerPlanHash(input: { workspaceJid: string; actorUserId: string; message: string; route: AgentRouterPlanSpec; capabilityHash: string | null }): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    workspaceJid: input.workspaceJid,
    actorUserId: input.actorUserId,
    message: input.message,
    route: input.route,
    capabilityHash: input.capabilityHash,
  })).digest('hex');
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
  const access = getWorkspaceAccess(db, actorUserId, workspaceJid);
  const allowedProfile = db.prepare(
    `SELECT 1 FROM agent_profiles p
     WHERE p.id = ? AND (
       p.owner_user_id = ? OR p.owner_user_id = ? OR EXISTS (
         SELECT 1 FROM workspaces w JOIN workspace_members m ON m.workspace_jid = w.jid
         WHERE w.agent_profile_id = p.id AND w.jid = ? AND m.user_id = ? AND m.status = 'active'
       )
     )`,
  ).get(input.agentProfileId, actorUserId, access?.workspaceOwnerUserId ?? '', workspaceJid, actorUserId);
  if (!allowedProfile) return { ok: false, reason: 'profile_not_found' };
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
  const approvalRequired = route.risk !== 'read';
  const approvalStatus: AgentRouterApprovalStatus = approvalRequired ? 'pending' : 'not_required';
  const approvalExpiresAt = approvalRequired ? new Date(Date.now() + ROUTER_APPROVAL_TTL_MS).toISOString() : null;
  const approvalHash = routerPlanHash({ workspaceJid, actorUserId, message: input, route, capabilityHash });
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_router_plans (
        id, workspace_jid, session_id, actor_user_id, intent, status,
        input_json, route_json, capability_hash, created_at, updated_at,
        approval_required, approval_status, approval_expires_at, approval_hash,
        approved_by, approved_at
      ) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(id, workspaceJid, sessionId, actorUserId, route.intent, JSON.stringify({ message: input }), JSON.stringify(route), capabilityHash, now, now, approvalRequired ? 1 : 0, approvalStatus, approvalExpiresAt, approvalHash);
    if (approvalRequired) {
      db.prepare(
        `INSERT INTO agent_router_approvals (
          id, plan_id, workspace_jid, actor_user_id, plan_hash, status,
          expires_at, decided_by, decided_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`,
      ).run(`ara_${crypto.randomUUID()}`, id, workspaceJid, actorUserId, approvalHash, approvalExpiresAt, now, now);
    }
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

export type RouterApprovalMutation =
  | { ok: true; status: 'approved' | 'rejected' }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'not_required' | 'expired' | 'already_decided' };

export type RouterCancellationMutation =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'already_terminal' };

export function expireRouterApprovals(db: Db, planId?: string, nowInput = new Date().toISOString()): number {
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE agent_router_approvals
       SET status = 'expired', updated_at = ?
       WHERE ${planId ? 'plan_id = ? AND ' : ''}status = 'pending' AND expires_at <= ?`,
    ).run(...(planId ? [nowInput, planId, nowInput] : [nowInput, nowInput])).changes;
    if (changed > 0) {
      db.prepare(
        `UPDATE agent_router_plans
         SET approval_status = 'expired', updated_at = ?
         WHERE approval_status = 'pending'
           AND id IN (SELECT plan_id FROM agent_router_approvals WHERE status = 'expired' AND updated_at = ?)`
      ).run(nowInput, nowInput);
    }
    return changed;
  })();
}

function decideRouterApproval(
  db: Db,
  actorUserId: string,
  workspaceJid: string,
  planId: string,
  decision: 'approved' | 'rejected',
): RouterApprovalMutation {
  expireRouterApprovals(db, planId);
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'converse')) return { ok: false, reason: 'not_found' };
  const plan = db.prepare(
    `SELECT id, actor_user_id, approval_required, approval_status, approval_hash
     FROM agent_router_plans WHERE id = ? AND workspace_jid = ?`,
  ).get(planId, workspaceJid) as { id: string; actor_user_id: string; approval_required: number; approval_status: AgentRouterApprovalStatus; approval_hash: string | null } | undefined;
  if (!plan) return { ok: false, reason: 'not_found' };
  const access = getWorkspaceAccess(db, actorUserId, workspaceJid);
  if (!access || (access.role !== 'workspace_admin' && plan.actor_user_id !== actorUserId)) return { ok: false, reason: 'forbidden' };
  if (plan.approval_required !== 1) return { ok: false, reason: 'not_required' };
  if (plan.approval_status === 'expired') return { ok: false, reason: 'expired' };
  if (plan.approval_status !== 'pending' || !plan.approval_hash) return { ok: false, reason: 'already_decided' };
  const now = new Date().toISOString();
  const changed = db.transaction(() => {
    const approval = db.prepare(
      `UPDATE agent_router_approvals
       SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?
       WHERE plan_id = ? AND status = 'pending' AND expires_at > ? AND plan_hash = ?`,
    ).run(decision, actorUserId, now, now, planId, now, plan.approval_hash).changes;
    if (approval !== 1) return false;
    return db.prepare(
      `UPDATE agent_router_plans
       SET approval_status = ?, approved_by = ?, approved_at = ?, updated_at = ?
       WHERE id = ? AND workspace_jid = ? AND approval_status = 'pending' AND approval_hash = ?`,
    ).run(decision, decision === 'approved' ? actorUserId : null, decision === 'approved' ? now : null, now, planId, workspaceJid, plan.approval_hash).changes === 1;
  })();
  if (!changed) return { ok: false, reason: 'already_decided' };
  appendRouterEvent(db, planId, null, { type: decision === 'approved' ? 'approval_approved' : 'approval_rejected', decidedBy: actorUserId });
  return { ok: true, status: decision };
}

export function approveRouterPlan(db: Db, actorUserId: string, workspaceJid: string, planId: string): RouterApprovalMutation {
  return decideRouterApproval(db, actorUserId, workspaceJid, planId, 'approved');
}

export function rejectRouterPlan(db: Db, actorUserId: string, workspaceJid: string, planId: string): RouterApprovalMutation {
  return decideRouterApproval(db, actorUserId, workspaceJid, planId, 'rejected');
}

export function cancelRouterPlan(db: Db, actorUserId: string, workspaceJid: string, planId: string): RouterCancellationMutation {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'converse')) return { ok: false, reason: 'not_found' };
  const plan = db.prepare(
    `SELECT id, actor_user_id, status FROM agent_router_plans
     WHERE id = ? AND workspace_jid = ?`,
  ).get(planId, workspaceJid) as { id: string; actor_user_id: string; status: AgentRouterPlanStatus } | undefined;
  if (!plan) return { ok: false, reason: 'not_found' };
  const access = getWorkspaceAccess(db, actorUserId, workspaceJid);
  if (!access || (access.role !== 'workspace_admin' && plan.actor_user_id !== actorUserId)) return { ok: false, reason: 'forbidden' };
  if (!['planned', 'running'].includes(plan.status)) return { ok: false, reason: 'already_terminal' };
  const now = new Date().toISOString();
  const changed = db.transaction(() => {
    const updated = db.prepare(
      `UPDATE agent_router_plans
       SET status = 'cancelled', approval_status = CASE WHEN approval_status = 'pending' THEN 'rejected' ELSE approval_status END,
           dispatch_owner = NULL, dispatch_lease_expires_at = NULL,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND workspace_jid = ? AND status IN ('planned', 'running')`,
    ).run(now, now, planId, workspaceJid).changes;
    if (updated !== 1) return false;
    db.prepare(
      `UPDATE agent_router_tasks
       SET status = CASE WHEN status IN ('queued', 'running') THEN 'skipped' ELSE status END,
           error = CASE WHEN status IN ('queued', 'running') THEN '编排已取消' ELSE error END,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = CASE WHEN status IN ('queued', 'running') THEN ? ELSE completed_at END
       WHERE plan_id = ?`,
    ).run(now, now, planId);
    db.prepare(
      `UPDATE agent_router_approvals
       SET status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END,
           decided_by = CASE WHEN status = 'pending' THEN ? ELSE decided_by END,
           decided_at = CASE WHEN status = 'pending' THEN ? ELSE decided_at END,
           updated_at = ?
       WHERE plan_id = ?`,
    ).run(actorUserId, now, now, planId);
    return true;
  })();
  if (!changed) return { ok: false, reason: 'already_terminal' };
  appendRouterEvent(db, planId, null, { type: 'plan_cancelled', cancelledBy: actorUserId });
  return { ok: true };
}

export function getRouterPlan(db: Db, actorUserId: string, workspaceJid: string, id: string): AgentRouterPlanRow | undefined {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'view')) return undefined;
  expireRouterApprovals(db, id);
  const row = db.prepare('SELECT * FROM agent_router_plans WHERE id = ? AND workspace_jid = ?').get(id, workspaceJid) as PlanDbRow | undefined;
  return row ? mapPlan(row) : undefined;
}

export function listRouterPlans(db: Db, actorUserId: string, workspaceJid: string): AgentRouterPlanRow[] | undefined {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'view')) return undefined;
  expireRouterApprovals(db);
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

export function listRouterTaskRows(db: Db, actorUserId: string, workspaceJid: string, planId: string): AgentRouterTaskRow[] | undefined {
  if (!getRouterPlan(db, actorUserId, workspaceJid, planId)) return undefined;
  const rows = db.prepare(
    `SELECT id, plan_id, ordinal, agent_binding_id, agent_profile_id, title,
            input_json, status, attempt, result_json, error
     FROM agent_router_tasks WHERE plan_id = ? ORDER BY ordinal`,
  ).all(planId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    planId: String(row.plan_id),
    spec: {
      ordinal: Number(row.ordinal),
      bindingId: row.agent_binding_id ? String(row.agent_binding_id) : null,
      agentProfileId: String(row.agent_profile_id),
      title: String(row.title),
      requiredCapabilities: parse<{ requiredCapabilities?: string[] }>(String(row.input_json))?.requiredCapabilities ?? [],
      input: parse<{ input?: string }>(String(row.input_json))?.input ?? '',
      dependsOn: parse<{ dependsOn?: number[] }>(String(row.input_json))?.dependsOn ?? [],
      risk: parse<{ risk?: AgentRouterTaskSpec['risk'] }>(String(row.input_json))?.risk ?? 'read',
    },
    status: String(row.status) as AgentRouterTaskStatus,
    attempt: Number(row.attempt),
    resultText: parse<{ text?: string }>(String(row.result_json))?.text ?? null,
    error: row.error ? String(row.error) : null,
  }));
}

export function setRouterPlanStatus(db: Db, planId: string, status: AgentRouterPlanStatus, result?: AgentRouterResult, workerId?: string): boolean {
  const now = new Date().toISOString();
  const where = workerId ? 'WHERE id = ? AND dispatch_owner = ? AND dispatch_lease_expires_at > ?' : 'WHERE id = ?';
  const params = [status, result ? JSON.stringify(result) : null, now, status, status, status, now, planId, ...(workerId ? [workerId, now] : [])];
  return db.prepare(`UPDATE agent_router_plans SET status = ?, result_json = COALESCE(?, result_json), updated_at = ?, dispatch_owner = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN NULL ELSE dispatch_owner END, dispatch_lease_expires_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN NULL ELSE dispatch_lease_expires_at END, completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE completed_at END ${where}`)
    .run(...params).changes === 1;
}

export function claimRouterPlan(db: Db, planId: string, workerId: string, leaseMs = DEFAULT_ROUTER_LEASE_MS): boolean {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  return db.prepare(
    `UPDATE agent_router_plans
     SET status = 'running', dispatch_owner = ?, dispatch_lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND (
       status = 'planned' OR
       (status = 'running' AND (
         dispatch_owner IS NULL OR dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at <= ? OR dispatch_owner = ?
       ))
     )`,
  ).run(workerId, expiresAt, nowIso, planId, nowIso, workerId).changes === 1;
}

export function renewRouterPlan(db: Db, planId: string, workerId: string, leaseMs = DEFAULT_ROUTER_LEASE_MS): boolean {
  const now = new Date();
  return db.prepare(
    `UPDATE agent_router_plans
     SET dispatch_lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND dispatch_owner = ? AND dispatch_lease_expires_at > ?`,
  ).run(new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), planId, workerId, now.toISOString()).changes === 1;
}

export function releaseRouterPlan(db: Db, planId: string, workerId: string): boolean {
  return db.prepare(
    `UPDATE agent_router_plans
     SET dispatch_owner = NULL, dispatch_lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND dispatch_owner = ?`,
  ).run(new Date().toISOString(), planId, workerId).changes === 1;
}

export function setRouterTaskStatus(db: Db, taskId: string, status: AgentRouterTaskStatus, result?: { text?: string; error?: string }, workerId?: string): boolean {
  const now = new Date().toISOString();
  const where = workerId
    ? `WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?
       AND EXISTS (
         SELECT 1 FROM agent_router_plans p
         WHERE p.id = agent_router_tasks.plan_id AND p.status = 'running'
           AND p.dispatch_owner = ? AND p.dispatch_lease_expires_at > ?
       )`
    : 'WHERE id = ?';
  const params = [status, status, result ? JSON.stringify(result) : null, result?.error ?? null, status, status, now, status, now, taskId, ...(workerId ? [workerId, now, workerId, now] : [])];
  return db.prepare(`UPDATE agent_router_tasks SET status = ?, attempt = attempt + CASE WHEN ? = 'running' THEN 1 ELSE 0 END, result_json = COALESCE(?, result_json), error = ?, lease_owner = CASE WHEN ? IN ('completed', 'failed', 'skipped') THEN NULL ELSE lease_owner END, lease_expires_at = CASE WHEN ? IN ('completed', 'failed', 'skipped') THEN NULL ELSE lease_expires_at END, updated_at = ?, completed_at = CASE WHEN ? IN ('completed', 'failed', 'skipped') THEN ? ELSE completed_at END ${where}`)
    .run(...params).changes === 1;
}

export function claimRouterTask(db: Db, taskId: string, workerId: string, leaseMs = DEFAULT_ROUTER_LEASE_MS): boolean {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  return db.prepare(
    `UPDATE agent_router_tasks
     SET status = 'running', attempt = attempt + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued', 'running') AND (
       lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?
     )`,
  ).run(workerId, expiresAt, nowIso, taskId, nowIso, workerId).changes === 1;
}

export function renewRouterTask(db: Db, taskId: string, workerId: string, leaseMs = DEFAULT_ROUTER_LEASE_MS): boolean {
  const now = new Date();
  return db.prepare(
    `UPDATE agent_router_tasks
     SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?`,
  ).run(new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), taskId, workerId, now.toISOString()).changes === 1;
}

export function skipRouterTask(db: Db, taskId: string, workerId: string, error: string): boolean {
  const now = new Date().toISOString();
  return db.prepare(
    `UPDATE agent_router_tasks
     SET status = 'skipped', error = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'queued'
       AND EXISTS (
         SELECT 1 FROM agent_router_plans p
         WHERE p.id = agent_router_tasks.plan_id AND p.status = 'running' AND p.dispatch_owner = ? AND p.dispatch_lease_expires_at > ?
       )`,
  ).run(error, now, now, taskId, workerId, now).changes === 1;
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
