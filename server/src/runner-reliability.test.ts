import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from './db/migration.js';
import {
  appendRunnerOutboxEvent,
  claimRunnerTurn,
  completeRunnerTurn,
  createRunnerSubmission,
  getRunnerTurnById,
  listRunnerOutbox,
  recoverRunnerRuns,
  retryRunnerTurn,
} from './runner-reliability.js';

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
});

describe('runner reliability store', () => {
  it('creates an idempotent Inbox/Turn pair and persists Outbox events', () => {
    const first = createRunnerSubmission(db, {
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      idempotencyKey: 'key-1',
      message: 'hello',
    });
    const duplicate = createRunnerSubmission(db, {
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      idempotencyKey: 'key-1',
      message: 'different but ignored',
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.turn.id).toBe(first.turn.id);
    expect(
      appendRunnerOutboxEvent(db, first.turn.id, 0, { eventType: 'text_delta', text: 'hi' }),
    ).toMatchObject({
      ordinal: 0,
      status: 'pending',
    });
    expect(listRunnerOutbox(db, first.turn.id)).toHaveLength(1);
  });

  it('fences attempts, supports retry, completion and stale-run recovery', () => {
    const submission = createRunnerSubmission(db, {
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      idempotencyKey: 'key-2',
      message: 'hello',
    });
    const claimed = claimRunnerTurn(db, submission.turn.id, 'worker-1', 10_000);
    expect(claimed).toMatchObject({ status: 'running', attempt: 1, leaseOwner: 'worker-1' });
    expect(
      retryRunnerTurn(
        db,
        submission.turn.id,
        'worker-1',
        'temporary',
        new Date(Date.now() - 1).toISOString(),
      ),
    ).toBe(true);
    const retry = claimRunnerTurn(db, submission.turn.id, 'worker-2', 10_000);
    expect(retry).toMatchObject({ status: 'running', attempt: 2, leaseOwner: 'worker-2' });
    expect(completeRunnerTurn(db, submission.turn.id, 'worker-2', 'done')).toBe(true);
    expect(getRunnerTurnById(db, submission.turn.id)).toMatchObject({
      status: 'completed',
      resultText: 'done',
    });

    const staleSubmission = createRunnerSubmission(db, {
      ownerUserId: 'u1',
      workspaceJid: 'w1',
      sessionId: 's1',
      idempotencyKey: 'key-3',
      message: 'stale',
      now: new Date('2020-01-01T00:00:00.000Z'),
    });
    claimRunnerTurn(
      db,
      staleSubmission.turn.id,
      'worker-3',
      1,
      new Date('2020-01-01T00:00:00.000Z'),
    );
    expect(recoverRunnerRuns(db, new Date('2020-01-01T00:00:02.000Z'))).toBe(1);
    expect(getRunnerTurnById(db, staleSubmission.turn.id)).toMatchObject({
      status: 'retry_wait',
    });
  });
});
