import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FakePiRunner } from '@deep-worker/pi-runner';
import type { AgentRunner } from '@deep-worker/pi-runner';
import { initDatabase } from './db/migration.js';
import {
  claimRunnerTurn,
  createRunnerSubmission,
  getRunnerTurnById,
  listRunnerOutbox,
} from './runner-reliability.js';
import { setBillingEnabled } from './billing.js';
import { RuntimeRunnerService } from './runtime-runner-service.js';
import { workspaceRoot } from './workspaces.js';

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(':memory:');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, status, permissions, created_at, updated_at)
     VALUES ('u1', 'u1', 'x', 'U1', 'member', 'active', '[]', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO workspaces (jid, folder, owner_user_id, name, status, is_home, created_at, updated_at)
     VALUES ('w1', 'w1', 'u1', 'W1', 'active', 0, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO runtime_sessions (id, workspace_jid, name, status, created_at, updated_at)
     VALUES ('s1', 'w1', 'S1', 'active', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO runtime_sessions (id, workspace_jid, name, status, created_at, updated_at)
     VALUES ('s2', 'w1', 'S2', 'active', ?, ?)`,
  ).run(now, now);
});

afterEach(() => {
  fs.rmSync(workspaceRoot('w1'), { recursive: true, force: true });
  fs.rmSync(workspaceRoot('w2'), { recursive: true, force: true });
});

describe('RuntimeRunnerService', () => {
  it('runs an API message through Inbox → Turn → Outbox and deduplicates it', async () => {
    const runner = new FakePiRunner({ response: 'hello', emitBash: true });
    const service = new RuntimeRunnerService({ db, runner, retryBaseMs: 0 });
    const streamed: string[] = [];
    const unsubscribe = service.streamHub.subscribe('s1', (event) =>
      streamed.push(event.eventType),
    );
    const first = await service.submit({
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      message: 'hello',
      idempotencyKey: 'message-1',
    });
    const duplicate = await service.submit({
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      message: 'ignored',
      idempotencyKey: 'message-1',
    });
    expect(first.reply).toBe('hello');
    expect(first.turn.status).toBe('completed');
    expect(first.events.map((event) => event.eventType)).toContain('tool_result');
    expect(streamed).toContain('text_delta');
    expect(duplicate.turn.id).toBe(first.turn.id);
    expect(runner.calls).toHaveLength(1);
    expect(listRunnerOutbox(db, first.turn.id).length).toBeGreaterThan(0);
    unsubscribe();
    await service.close();
  });

  it('使用安全的工作区根目录，不把数据库中的 folder 当作 Windows cwd', async () => {
    db.prepare('UPDATE workspaces SET folder = ? WHERE jid = ?').run(
      'web:invalid-windows-folder',
      'w1',
    );
    let observedCwd: string | undefined;
    const runner: AgentRunner = {
      async run(request) {
        observedCwd = request.cwd;
        expect(request.cwd).toBe(workspaceRoot('w1'));
        expect(fs.existsSync(request.cwd!)).toBe(true);
        return { sessionId: request.sessionId, reply: '路径正常', events: [], attempts: 1 };
      },
      async close() {},
    };
    const service = new RuntimeRunnerService({ db, runner, retryBaseMs: 0 });

    const result = await service.submit({
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      message: '检查工作区路径',
      idempotencyKey: 'workspace-path',
    });

    expect(result.reply).toBe('路径正常');
    expect(observedCwd).toBe(workspaceRoot('w1'));
    await service.close();
  });

  it('把已解析的能力清单传递给 Pi Runner', async () => {
    const runner = new FakePiRunner({ response: 'capability reply' });
    const service = new RuntimeRunnerService({ db, runner, retryBaseMs: 0 });
    await service.submit({
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      message: 'use capabilities',
      idempotencyKey: 'capability-message',
      capabilities: { hash: 'cap-hash', skills: [], mcpServers: [], plugins: [] },
    });
    expect(runner.calls[0].capabilityHash).toBe('cap-hash');
    expect(runner.calls[0].capabilities?.hash).toBe('cap-hash');
    await service.close();
  });

  it('收到取消信号时终止当前 Runner 且不触发重试', async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      async run(request) {
        calls.push(request.message);
        return await new Promise<import('@deep-worker/pi-runner').AgentRunResult>((resolve, reject) => {
          const timer = setTimeout(() => resolve({ sessionId: request.sessionId, reply: '不应完成', events: [], attempts: 1 }), 100);
          request.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('runner aborted'));
          }, { once: true });
        });
      },
      async close() {},
    };
    const service = new RuntimeRunnerService({ db, runner, retryBaseMs: 0, maxAttempts: 3 });
    const controller = new AbortController();
    const pending = service.submit({
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      message: '取消任务',
      idempotencyKey: 'cancel-task',
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;
    expect(result.turn.status).toBe('failed');
    expect(result.turn.error).toContain('aborted');
    expect(calls).toHaveLength(1);
    await service.close();
  });

  it('retries a failed runner and preserves the final durable state', async () => {
    const runner = new FakePiRunner({ response: 'recovered', failuresBeforeSuccess: 2 });
    const service = new RuntimeRunnerService({
      db,
      runner,
      maxAttempts: 3,
      retryBaseMs: 0,
    });
    const result = await service.submit({
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      message: 'retry',
      idempotencyKey: 'message-retry',
    });
    expect(result.reply).toBe('recovered');
    expect(result.turn).toMatchObject({ status: 'completed', attempt: 3 });
    expect(runner.calls).toHaveLength(3);
    await service.close();
  });

  it('does not retry billing failures and persists a readable terminal event', async () => {
    setBillingEnabled(db, true);
    db.prepare('INSERT INTO user_balances (user_id, balance_usd, updated_at) VALUES (?, ?, ?)').run(
      'u1',
      -0.01,
      new Date().toISOString(),
    );
    const runner = new FakePiRunner({ response: '不应执行' });
    const service = new RuntimeRunnerService({ db, runner, retryBaseMs: 100 });

    const result = await service.submit({
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      message: '余额不足',
      idempotencyKey: 'billing-failure',
    });

    expect(result.turn).toMatchObject({ status: 'failed', attempt: 1 });
    expect(result.reply).toBeNull();
    expect(runner.calls).toHaveLength(0);
    expect(result.events.at(-1)).toMatchObject({
      eventType: 'status',
      statusText: 'agent failed',
      detail: '余额不足，至少需要 $0.00',
    });
    await service.close();
  });

  it('关闭本地计费时，零余额消息仍会进入 Runner', async () => {
    db.prepare('INSERT INTO user_balances (user_id, balance_usd, updated_at) VALUES (?, ?, ?)').run(
      'u1',
      0,
      new Date().toISOString(),
    );
    const runner = new FakePiRunner({ response: '已调用模型' });
    const service = new RuntimeRunnerService({ db, runner, retryBaseMs: 0 });

    const result = await service.submit({
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      message: '无余额也执行',
      idempotencyKey: 'free-model-call',
    });

    expect(result.reply).toBe('已调用模型');
    expect(result.turn.status).toBe('completed');
    expect(runner.calls).toHaveLength(1);
    await service.close();
  });

  it('allows different sessions to run concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const runner: AgentRunner = {
      async run(request) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return {
          sessionId: request.sessionId,
          reply: request.message,
          events: [],
          attempts: 1,
        };
      },
      async close() {
        // 测试运行器不持有外部资源。
      },
    };
    const service = new RuntimeRunnerService({ db, runner, retryBaseMs: 0 });
    await Promise.all([
      service.submit({
        ownerUserId: 'u1',
        workspaceJid: 'w1',
        sessionId: 's1',
        message: 'a',
        idempotencyKey: 'a',
      }),
      service.submit({
        ownerUserId: 'u1',
        workspaceJid: 'w1',
        sessionId: 's2',
        message: 'b',
        idempotencyKey: 'b',
      }),
    ]);
    expect(maxActive).toBe(2);
    await service.close();
  });

  it('resumes a stale turn after a service restart', async () => {
    const submission = createRunnerSubmission(db, {
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      message: 'resume me',
      idempotencyKey: 'restart-1',
      now: new Date('2020-01-01T00:00:00.000Z'),
    });
    claimRunnerTurn(
      db,
      submission.turn.id,
      'dead-worker',
      1,
      new Date('2020-01-01T00:00:00.000Z'),
    );

    const runner = new FakePiRunner({ response: 'resumed' });
    const service = new RuntimeRunnerService({ db, runner, retryBaseMs: 0 });
    await service.resumePending();

    expect(getRunnerTurnById(db, submission.turn.id)).toMatchObject({
      status: 'completed',
      resultText: 'resumed',
      attempt: 2,
    });
    expect(runner.calls).toHaveLength(1);
    await service.close();
  });
});
