import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { initDatabase } from './db/migration.js';
import {
  claimRunnerTurn,
  createRunnerSubmission,
  getRunnerTurnById,
  listRunnerOutbox,
} from './runner-reliability.js';
import { RuntimeRunnerService } from './runtime-runner-service.js';

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

  it('allows different sessions to run concurrently', async () => {
    const runner = new FakePiRunner({ delayMs: 30 });
    const service = new RuntimeRunnerService({ db, runner, retryBaseMs: 0 });
    const started = Date.now();
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
    expect(Date.now() - started).toBeLessThan(55);
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
