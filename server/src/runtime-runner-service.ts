import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AgentRunner, AgentRunRequest } from '@deep-worker/pi-runner';
import { SessionQueue, type SessionQueueOptions } from '@deep-worker/pi-runner';
import type { StreamEvent } from '@deep-worker/shared';
import { getOwnedAgentProfile } from './agent-profiles.js';
import { getOwnedRuntimeSession } from './runtime-sessions.js';
import { getOwnedWorkspace } from './workspaces.js';
import { effectiveExecutionMode } from './execution-policy.js';
import {
  appendRunnerOutboxEvent,
  claimRunnerTurn,
  completeRunnerTurn,
  createRunnerSubmission,
  failRunnerTurn,
  getRunnerInboxById,
  getRunnerSubmissionByKey,
  getRunnerTurnById,
  listRunnableRunnerTurns,
  listRunnerOutbox,
  markRunnerOutboxDelivered,
  recoverRunnerRuns,
  retryRunnerTurn,
  toRunnerTurnPublic,
  type Db,
  type RunnerTurnRow,
} from './runner-reliability.js';

export interface RuntimeRunnerMessageInput {
  ownerUserId: string;
  workspaceJid: string;
  sessionId: string;
  message: string;
  idempotencyKey: string;
  systemPrompt?: string;
  outputContract?: string;
  timeoutMs?: number;
  capabilities?: AgentRunRequest['capabilities'];
}

export interface RuntimeRunnerResult {
  turn: RunnerTurnRow;
  reply: string | null;
  events: StreamEvent[];
}

export type StreamEventListener = (event: StreamEvent) => void;

export class RunnerStreamHub {
  private readonly listeners = new Map<string, Set<StreamEventListener>>();

  subscribe(sessionId: string, listener: StreamEventListener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<StreamEventListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  publish(sessionId: string, event: StreamEvent): number {
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return 0;
    for (const listener of listeners) listener(event);
    return listeners.size;
  }
}

export interface RuntimeRunnerServiceOptions {
  db: Db;
  runner: AgentRunner;
  containerRunner?: AgentRunner;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  queueOptions?: SessionQueueOptions;
  workerId?: string;
  streamHub?: RunnerStreamHub;
}

const sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/** 为任意智能体运行器提供可恢复的收件箱、执行回合和待发事件编排。 */
export class RuntimeRunnerService {
  readonly streamHub: RunnerStreamHub;
  private readonly db: Db;
  private readonly runner: AgentRunner;
  private readonly containerRunner: AgentRunner;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly workerId: string;
  private readonly queue: SessionQueue;

  constructor(options: RuntimeRunnerServiceOptions) {
    this.db = options.db;
    this.runner = options.runner;
    // 直接注入的 Fake Runner 作为测试容器引擎；生产应用会显式传入 ContainerRunner。
    this.containerRunner = options.containerRunner ?? options.runner;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 100;
    this.workerId = options.workerId ?? `runner-${crypto.randomUUID()}`;
    this.streamHub = options.streamHub ?? new RunnerStreamHub();
    this.queue = new SessionQueue({
      maxAttempts: 1,
      ...options.queueOptions,
    });
    recoverRunnerRuns(this.db);
  }

  async submit(input: RuntimeRunnerMessageInput): Promise<RuntimeRunnerResult> {
    const session = getOwnedRuntimeSession(
      this.db,
      input.ownerUserId,
      input.workspaceJid,
      input.sessionId,
    );
    if (!session || session.status !== 'active') throw new Error('Runtime session not found');
    const submission = createRunnerSubmission(this.db, {
      ownerUserId: input.ownerUserId,
      workspaceJid: input.workspaceJid,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      message: input.message,
    });
    if (
      submission.inbox.ownerUserId !== input.ownerUserId ||
      submission.inbox.workspaceJid !== input.workspaceJid ||
      submission.inbox.sessionId !== input.sessionId
    ) {
      throw new Error('Idempotency key belongs to another runtime session');
    }
    const result = await this.queue.enqueue(input.sessionId, () =>
      this.processTurn(submission.turn.id, {
        systemPrompt: input.systemPrompt,
        outputContract: input.outputContract,
        timeoutMs: input.timeoutMs,
        capabilities: input.capabilities,
      }),
    );
    return result.value;
  }

  async resumePending(): Promise<void> {
    recoverRunnerRuns(this.db);
    const turns = listRunnableRunnerTurns(this.db);
    await Promise.all(
      turns.map(async (turn) => {
        await this.queue.enqueue(turn.sessionId, () => this.processTurn(turn.id, {}));
      }),
    );
  }

  async close(): Promise<void> {
    this.queue.close();
    await this.runner.close();
  }

  private async processTurn(
    turnId: string,
    options: { systemPrompt?: string; outputContract?: string; timeoutMs?: number; capabilities?: AgentRunRequest['capabilities'] },
  ): Promise<RuntimeRunnerResult> {
    const first = getRunnerTurnById(this.db, turnId);
    if (!first) throw new Error('Runner turn not found');
    const inbox = getRunnerInboxById(this.db, first.inboxId);
    if (!inbox) throw new Error('Runner inbox not found');
    const events: StreamEvent[] = [];
    let nextOrdinal = listRunnerOutbox(this.db, turnId).length;
    while (true) {
      const claim = claimRunnerTurn(this.db, turnId, this.workerId, this.leaseMs);
      if (!claim) {
        const current = getRunnerTurnById(this.db, turnId);
        if (!current) throw new Error('Runner turn disappeared');
        return this.resultFromPersistence(current);
      }
      try {
        const session = getOwnedRuntimeSession(
          this.db,
          inbox.ownerUserId,
          inbox.workspaceJid,
          inbox.sessionId,
        );
        const workspace = getOwnedWorkspace(this.db, inbox.ownerUserId, inbox.workspaceJid);
        if (!session || session.status !== 'active' || !workspace)
          throw new Error('Runtime session not found');
        const profile = session.agent_profile_id
          ? getOwnedAgentProfile(this.db, inbox.ownerUserId, session.agent_profile_id)
          : undefined;
        const request: AgentRunRequest = {
          sessionId: inbox.sessionId,
          message: inbox.message,
          cwd: workspace.folder,
          systemPrompt: options.systemPrompt ?? profile?.identity_prompt,
          outputContract: options.outputContract,
          timeoutMs: options.timeoutMs,
          turnId,
          queryRunId: turnId,
          identityHash: profile?.identity_hash,
          capabilities: options.capabilities,
          capabilityHash: options.capabilities?.hash,
        };
        const executionRunner = effectiveExecutionMode(this.db, workspace) === 'container'
          ? this.containerRunner
          : this.runner;
        const result = await executionRunner.run(request, (event) => {
          events.push(event);
          this.persistAndPublish(inbox.sessionId, turnId, nextOrdinal, event);
          nextOrdinal += 1;
        });
        if (events.length === 0) {
          for (const event of result.events) {
            events.push(event);
            this.persistAndPublish(inbox.sessionId, turnId, nextOrdinal, event);
            nextOrdinal += 1;
          }
        }
        completeRunnerTurn(this.db, turnId, this.workerId, result.reply);
        const completed = getRunnerTurnById(this.db, turnId)!;
        return { turn: completed, reply: result.reply, events };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = getRunnerTurnById(this.db, turnId)!;
        if (current.attempt < this.maxAttempts) {
          const delayMs = Math.min(5_000, this.retryBaseMs * 2 ** (current.attempt - 1));
          retryRunnerTurn(
            this.db,
            turnId,
            this.workerId,
            message,
            new Date(Date.now() + delayMs).toISOString(),
          );
          if (delayMs > 0) await sleep(delayMs);
          continue;
        }
        failRunnerTurn(this.db, turnId, this.workerId, message);
        const failed = getRunnerTurnById(this.db, turnId)!;
        return { turn: failed, reply: null, events };
      }
    }
  }

  private persistAndPublish(
    sessionId: string,
    turnId: string,
    ordinal: number,
    event: StreamEvent,
  ): void {
    const outbox = appendRunnerOutboxEvent(this.db, turnId, ordinal, event);
    const listenerCount = this.streamHub.publish(sessionId, event);
    if (listenerCount > 0) markRunnerOutboxDelivered(this.db, outbox.id);
  }

  private resultFromPersistence(turn: RunnerTurnRow): RuntimeRunnerResult {
    return {
      turn,
      reply: turn.resultText,
      events: listRunnerOutbox(this.db, turn.id).map((item) => item.event as StreamEvent),
    };
  }
}
