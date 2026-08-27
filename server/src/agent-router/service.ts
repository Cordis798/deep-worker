import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AgentRouterResult, AgentRouterTaskResult } from '@deep-worker/shared';
import { getAgentProfileById } from '../agent-profiles.js';
import { createAccessibleRuntimeSession } from '../runtime-sessions.js';
import { RuntimeRunnerService } from '../runtime-runner-service.js';
import { resolveCapabilitiesForWorkspace } from '../capabilities/capability-resolver.js';
import { isTaskCapabilityAllowed, type CapabilityGovernance } from '../capabilities/capability-governance.js';
import { getWorkspaceById } from '../workspaces.js';
import { buildAgentRouterPlan } from './planner.js';
import {
  appendRouterEvent,
  approveRouterPlan,
  cancelRouterPlan,
  claimRouterPlan,
  claimRouterTask,
  createRouterPlan,
  getRouterPlan,
  listAgentBindings,
  listRouterTaskRows,
  setRouterPlanStatus,
  setRouterTaskStatus,
  renewRouterPlan,
  renewRouterTask,
  rejectRouterPlan,
  skipRouterTask,
  type AgentBindingRow,
  type AgentRouterPlanRow,
  type AgentRouterTaskRow,
} from './store.js';

export type Db = Database.Database;

export class RouterDispatchBusyError extends Error {
  constructor() {
    super('Router plan is already being dispatched');
    this.name = 'RouterDispatchBusyError';
  }
}

export class RouterApprovalRequiredError extends Error {
  constructor(public readonly approvalStatus: 'pending' | 'rejected' | 'expired') {
    super(approvalStatus === 'pending' ? 'Router plan requires approval' : `Router plan approval is ${approvalStatus}`);
    this.name = 'RouterApprovalRequiredError';
  }
}

const MAX_PARALLEL_ROUTER_TASKS = 3;

export class AgentRouterService {
  private readonly activeDispatches = new Map<string, AbortController>();

  constructor(
    private readonly db: Db,
    private readonly runtime: RuntimeRunnerService,
  ) {}

  plan(input: { actorUserId: string; workspaceJid: string; sessionId?: string | null; message: string }): AgentRouterPlanRow {
    let candidates = this.candidates(input.actorUserId, input.workspaceJid);
    let capabilityHash: string | null = null;
    try {
      const manifest = resolveCapabilitiesForWorkspace(this.db, input.actorUserId, input.workspaceJid);
      capabilityHash = manifest.hash;
      candidates = this.applyTaskGovernance(candidates, manifest.governance);
    } catch {
      // 治理解析失败时不向 Planner 暴露未过滤候选，避免越权路由。
      candidates = [];
    }
    const route = buildAgentRouterPlan(input.message, candidates);
    return createRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.sessionId ?? null, input.message, route, capabilityHash);
  }

  approve(input: { actorUserId: string; workspaceJid: string; planId: string }) {
    return approveRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.planId);
  }

  reject(input: { actorUserId: string; workspaceJid: string; planId: string }) {
    return rejectRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.planId);
  }

  cancel(input: { actorUserId: string; workspaceJid: string; planId: string }) {
    const result = cancelRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.planId);
    if (result.ok) this.activeDispatches.get(input.planId)?.abort();
    return result;
  }

  async dispatch(input: { actorUserId: string; workspaceJid: string; planId: string }): Promise<AgentRouterResult> {
    const plan = getRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.planId);
    const tasks = listRouterTaskRows(this.db, input.actorUserId, input.workspaceJid, input.planId);
    if (!plan || !tasks) throw new Error('Router plan not found');
    if (plan.status === 'cancelled') return plan.result ?? this.resultFromTasks(input, plan, tasks.map((task) => ({
      taskId: task.id,
      ordinal: task.spec.ordinal,
      agentProfileId: task.spec.agentProfileId,
      status: task.status,
      text: task.resultText,
      ...(task.error ? { error: task.error } : {}),
    })));
    if (plan.approvalRequired && plan.approvalStatus !== 'approved') {
      throw new RouterApprovalRequiredError(plan.approvalStatus === 'pending' ? 'pending' : plan.approvalStatus === 'expired' ? 'expired' : 'rejected');
    }
    if (plan.status === 'completed') return plan.result ?? this.resultFromTasks(input, plan, []);
    const workerId = `router-worker:${crypto.randomUUID()}`;
    const abortController = new AbortController();
    this.activeDispatches.set(plan.id, abortController);
    if (!claimRouterPlan(this.db, plan.id, workerId)) {
      this.activeDispatches.delete(plan.id);
      const current = getRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.planId);
      if (current?.status === 'completed') return current.result ?? this.resultFromTasks(input, current, []);
      if (current?.status === 'cancelled') return current.result ?? this.resultFromTasks(input, current, []);
      throw new RouterDispatchBusyError();
    }
    appendRouterEvent(this.db, plan.id, null, { type: 'plan_started', planId: plan.id });
    if (tasks.length > 1 && tasks.every((task) => task.spec.dependsOn.length === 0)) {
      return this.dispatchIndependentTasks(input, plan, tasks, workerId, abortController);
    }
    const results: AgentRouterTaskResult[] = [];
    let failed = false;
    try {
      for (const task of tasks) {
        if (abortController.signal.aborted || getRouterPlan(this.db, input.actorUserId, input.workspaceJid, plan.id)?.status === 'cancelled') {
          return this.resultFromTasks(input, getRouterPlan(this.db, input.actorUserId, input.workspaceJid, plan.id) ?? plan, results);
        }
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'skipped') {
        const status = task.status;
        results.push({ taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status, text: task.resultText, ...(task.error ? { error: task.error } : {}) });
        if (status === 'failed') failed = true;
          continue;
        }
        if (failed || task.spec.dependsOn.some((ordinal) => results.find((result) => result.ordinal === ordinal)?.status !== 'completed')) {
        if (!skipRouterTask(this.db, task.id, workerId, '依赖任务未完成')) throw new RouterDispatchBusyError();
        results.push({ taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status: 'skipped', text: null, error: '依赖任务未完成' });
          continue;
        }
        if (!claimRouterTask(this.db, task.id, workerId)) {
        const current = listRouterTaskRows(this.db, input.actorUserId, input.workspaceJid, input.planId)?.find((item) => item.id === task.id);
        if (current?.status === 'completed') {
          results.push({ taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status: 'completed', text: current.resultText });
          continue;
        }
          throw new RouterDispatchBusyError();
        }
        appendRouterEvent(this.db, plan.id, task.id, { type: 'task_started', ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId });
        let leaseLost = false;
        const heartbeat = setInterval(() => {
        if (!renewRouterPlan(this.db, plan.id, workerId) || !renewRouterTask(this.db, task.id, workerId)) leaseLost = true;
        }, 30_000);
        try {
        const session = createAccessibleRuntimeSession(this.db, input.actorUserId, input.workspaceJid, {
          name: `Router ${plan.id.slice(-8)} · ${task.spec.title}`,
          agent_profile_id: task.spec.agentProfileId,
        });
        if (!session.ok || !session.id) throw new Error('无法创建子 Agent 会话');
        const context = results.filter((result) => result.status === 'completed' && result.text).map((result) => `任务 ${result.ordinal}: ${result.text}`).join('\n');
          const run = await this.runtime.submit({
          ownerUserId: input.actorUserId,
          workspaceJid: input.workspaceJid,
          sessionId: session.id,
          message: context ? `${task.spec.input}\n\n前置任务结果：\n${context}` : task.spec.input,
          idempotencyKey: `router:${plan.id}:${task.id}`,
          signal: abortController.signal,
        });
          if (abortController.signal.aborted || leaseLost) {
            const current = getRouterPlan(this.db, input.actorUserId, input.workspaceJid, plan.id);
            if (current?.status !== 'cancelled') throw new RouterDispatchBusyError();
            return this.resultFromTasks(input, current, results);
          }
          if (!setRouterTaskStatus(this.db, task.id, 'completed', { text: run.reply ?? '' }, workerId)) throw new RouterDispatchBusyError();
          appendRouterEvent(this.db, plan.id, task.id, { type: 'task_completed', ordinal: task.spec.ordinal, text: run.reply ?? '' });
          results.push({ taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status: 'completed', text: run.reply ?? '' });
        } catch (error) {
          if (error instanceof RouterDispatchBusyError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (abortController.signal.aborted || getRouterPlan(this.db, input.actorUserId, input.workspaceJid, plan.id)?.status === 'cancelled') {
            return this.resultFromTasks(input, getRouterPlan(this.db, input.actorUserId, input.workspaceJid, plan.id) ?? plan, results);
          }
          if (leaseLost || !setRouterTaskStatus(this.db, task.id, 'failed', { error: message }, workerId)) throw new RouterDispatchBusyError();
          appendRouterEvent(this.db, plan.id, task.id, { type: 'task_failed', ordinal: task.spec.ordinal, error: message });
          results.push({ taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status: 'failed', text: null, error: message });
          failed = true;
        } finally {
          clearInterval(heartbeat);
        }
      }
      const result = this.resultFromTasks(input, plan, results);
      if (!setRouterPlanStatus(this.db, plan.id, failed ? 'failed' : 'completed', result, workerId)) throw new RouterDispatchBusyError();
      appendRouterEvent(this.db, plan.id, null, { type: failed ? 'plan_failed' : 'plan_completed', planId: plan.id });
      return result;
    } finally {
      this.activeDispatches.delete(plan.id);
    }
  }

  private async dispatchIndependentTasks(
    input: { actorUserId: string; workspaceJid: string; planId: string },
    plan: AgentRouterPlanRow,
    tasks: AgentRouterTaskRow[],
    workerId: string,
    abortController: AbortController,
  ): Promise<AgentRouterResult> {
    const results: AgentRouterTaskResult[] = [];
    for (let index = 0; index < tasks.length; index += MAX_PARALLEL_ROUTER_TASKS) {
      if (abortController.signal.aborted) {
        const current = getRouterPlan(this.db, input.actorUserId, input.workspaceJid, plan.id) ?? plan;
        return this.resultFromTasks(input, current, results);
      }
      const batch = tasks.slice(index, index + MAX_PARALLEL_ROUTER_TASKS);
      const batchResults = await Promise.all(batch.map((task) => this.executeIndependentTask(input, task, workerId, abortController)));
      results.push(...batchResults);
      if (batchResults.some((result) => result.status === 'failed')) {
        // Independent tasks do not block each other; continue the remaining batch.
        continue;
      }
    }
    const current = getRouterPlan(this.db, input.actorUserId, input.workspaceJid, plan.id) ?? plan;
    if (current.status === 'cancelled' || abortController.signal.aborted) return this.resultFromTasks(input, current, results);
    const failed = results.some((result) => result.status === 'failed');
    const result = this.resultFromTasks(input, current, results);
    if (!setRouterPlanStatus(this.db, plan.id, failed ? 'failed' : 'completed', result, workerId)) throw new RouterDispatchBusyError();
    appendRouterEvent(this.db, plan.id, null, { type: failed ? 'plan_failed' : 'plan_completed', planId: plan.id, parallel: true });
    return result;
  }

  private async executeIndependentTask(
    input: { actorUserId: string; workspaceJid: string; planId: string },
    task: AgentRouterTaskRow,
    workerId: string,
    abortController: AbortController,
  ): Promise<AgentRouterTaskResult> {
    const existing = listRouterTaskRows(this.db, input.actorUserId, input.workspaceJid, input.planId)?.find((row) => row.id === task.id);
    if (existing && ['completed', 'failed', 'skipped'].includes(existing.status)) return this.taskResult(existing);
    if (!claimRouterTask(this.db, task.id, workerId)) {
      const current = listRouterTaskRows(this.db, input.actorUserId, input.workspaceJid, input.planId)?.find((row) => row.id === task.id);
      if (current && ['completed', 'failed', 'skipped'].includes(current.status)) return this.taskResult(current);
      throw new RouterDispatchBusyError();
    }
    appendRouterEvent(this.db, input.planId, task.id, { type: 'task_started', ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, parallel: true });
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      if (!renewRouterPlan(this.db, input.planId, workerId) || !renewRouterTask(this.db, task.id, workerId)) leaseLost = true;
    }, 30_000);
    try {
      const session = createAccessibleRuntimeSession(this.db, input.actorUserId, input.workspaceJid, {
        name: `Router ${input.planId.slice(-8)} · ${task.spec.title}`,
        agent_profile_id: task.spec.agentProfileId,
      });
      if (!session.ok || !session.id) throw new Error('无法创建子 Agent 会话');
      const run = await this.runtime.submit({
        ownerUserId: input.actorUserId,
        workspaceJid: input.workspaceJid,
        sessionId: session.id,
        message: task.spec.input,
        idempotencyKey: `router:${input.planId}:${task.id}`,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted || leaseLost) {
        const currentPlan = getRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.planId);
        if (currentPlan?.status !== 'cancelled') throw new RouterDispatchBusyError();
        return this.taskResult(listRouterTaskRows(this.db, input.actorUserId, input.workspaceJid, input.planId)?.find((row) => row.id === task.id) ?? task);
      }
      if (!setRouterTaskStatus(this.db, task.id, 'completed', { text: run.reply ?? '' }, workerId)) throw new RouterDispatchBusyError();
      appendRouterEvent(this.db, input.planId, task.id, { type: 'task_completed', ordinal: task.spec.ordinal, text: run.reply ?? '', parallel: true });
      return { taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status: 'completed', text: run.reply ?? '' };
    } catch (error) {
      if (error instanceof RouterDispatchBusyError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const currentPlan = getRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.planId);
      if (abortController.signal.aborted || currentPlan?.status === 'cancelled') {
        const current = listRouterTaskRows(this.db, input.actorUserId, input.workspaceJid, input.planId)?.find((row) => row.id === task.id);
        return this.taskResult(current ?? task);
      }
      if (leaseLost || !setRouterTaskStatus(this.db, task.id, 'failed', { error: message }, workerId)) throw new RouterDispatchBusyError();
      appendRouterEvent(this.db, input.planId, task.id, { type: 'task_failed', ordinal: task.spec.ordinal, error: message, parallel: true });
      return { taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status: 'failed', text: null, error: message };
    } finally {
      clearInterval(heartbeat);
    }
  }

  private taskResult(task: AgentRouterTaskRow): AgentRouterTaskResult {
    return {
      taskId: task.id,
      ordinal: task.spec.ordinal,
      agentProfileId: task.spec.agentProfileId,
      status: task.status,
      text: task.resultText,
      ...(task.error ? { error: task.error } : {}),
    };
  }

  private candidates(actorUserId: string, workspaceJid: string): AgentBindingRow[] {
    const bindings = listAgentBindings(this.db, actorUserId, workspaceJid) ?? [];
    if (bindings.length > 0) return bindings;
    const workspace = getWorkspaceById(this.db, workspaceJid);
    if (!workspace?.agent_profile_id) return [];
    const profile = getAgentProfileById(this.db, workspace.agent_profile_id);
    if (!profile) return [];
    return [{
      bindingId: null,
      agentProfileId: profile.id,
      name: profile.name,
      capabilities: ['*'],
      roleTags: ['general'],
      priority: 0,
      workspaceJid,
      enabled: true,
      createdBy: profile.owner_user_id,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
    }];
  }

  private applyTaskGovernance(candidates: AgentBindingRow[], governance?: CapabilityGovernance): AgentBindingRow[] {
    if (!governance) return candidates;
    return candidates.map((candidate) => ({
      ...candidate,
      capabilities: candidate.capabilities.includes('*') && governance.taskCapabilities.includes('*')
        ? ['*']
        : candidate.capabilities.filter((capability) => isTaskCapabilityAllowed(governance, capability)),
    }));
  }

  private resultFromTasks(input: { planId: string }, plan: AgentRouterPlanRow, tasks: AgentRouterTaskResult[]): AgentRouterResult {
    return {
      planId: input.planId,
      status: tasks.some((task) => task.status === 'failed')
        ? 'failed'
        : plan.status === 'cancelled'
          ? 'cancelled'
          : plan.status === 'awaiting_approval'
            ? 'awaiting_approval'
        : tasks.length > 0 && tasks.every((task) => task.status === 'completed')
          ? 'completed'
          : plan.status === 'planned'
            ? 'planned'
            : 'completed',
      text: tasks.length ? tasks.filter((task) => task.text).map((task) => task.text).join('\n\n') : null,
      tasks,
    };
  }
}
