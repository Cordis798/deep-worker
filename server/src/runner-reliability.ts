import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export type Db = Database.Database;
export type RunnerInboxStatus = 'queued' | 'processing' | 'retry_wait' | 'completed' | 'failed';
export type RunnerTurnStatus = 'queued' | 'running' | 'retry_wait' | 'completed' | 'failed';
export type RunnerOutboxStatus = 'pending' | 'delivered' | 'failed';

export interface RunnerSubmission {
  ownerUserId: string;
  workspaceJid: string;
  sessionId: string;
  idempotencyKey: string;
  message: string;
  now?: Date | string;
}

export interface RunnerInboxRow {
  id: string;
  ownerUserId: string;
  workspaceJid: string;
  sessionId: string;
  idempotencyKey: string;
  message: string;
  status: RunnerInboxStatus;
  availableAt: string;
  attempt: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RunnerTurnRow {
  id: string;
  inboxId: string;
  ownerUserId: string;
  workspaceJid: string;
  sessionId: string;
  status: RunnerTurnStatus;
  availableAt: string;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  resultText: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunnerOutboxRow {
  id: string;
  turnId: string;
  ordinal: number;
  event: unknown;
  status: RunnerOutboxStatus;
  createdAt: string;
  deliveredAt: string | null;
}

export interface RunnerSubmissionResult {
  created: boolean;
  inbox: RunnerInboxRow;
  turn: RunnerTurnRow;
}

interface InboxDbRow {
  id: string;
  owner_user_id: string;
  workspace_jid: string;
  session_id: string;
  idempotency_key: string;
  message: string;
  status: RunnerInboxStatus;
  available_at: string;
  attempt: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface TurnDbRow {
  id: string;
  inbox_id: string;
  owner_user_id: string;
  workspace_jid: string;
  session_id: string;
  status: RunnerTurnStatus;
  available_at: string;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  result_text: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface OutboxDbRow {
  id: string;
  turn_id: string;
  ordinal: number;
  event_json: string;
  status: RunnerOutboxStatus;
  created_at: string;
  delivered_at: string | null;
}

function isoNow(now?: Date | string): string {
  return now instanceof Date ? now.toISOString() : (now ?? new Date().toISOString());
}

function addMs(now: string, milliseconds: number): string {
  return new Date(new Date(now).getTime() + milliseconds).toISOString();
}

function mapInbox(row: InboxDbRow): RunnerInboxRow {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    workspaceJid: row.workspace_jid,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    message: row.message,
    status: row.status,
    availableAt: row.available_at,
    attempt: row.attempt,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapTurn(row: TurnDbRow): RunnerTurnRow {
  return {
    id: row.id,
    inboxId: row.inbox_id,
    ownerUserId: row.owner_user_id,
    workspaceJid: row.workspace_jid,
    sessionId: row.session_id,
    status: row.status,
    availableAt: row.available_at,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    resultText: row.result_text,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapOutbox(row: OutboxDbRow): RunnerOutboxRow {
  let event: unknown = null;
  try {
    event = JSON.parse(row.event_json);
  } catch {
    event = row.event_json;
  }
  return {
    id: row.id,
    turnId: row.turn_id,
    ordinal: row.ordinal,
    event,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export function getRunnerTurnById(db: Db, id: string): RunnerTurnRow | undefined {
  const row = db.prepare('SELECT * FROM runner_turns WHERE id = ?').get(id) as
    TurnDbRow | undefined;
  return row ? mapTurn(row) : undefined;
}

export function getRunnerInboxById(db: Db, id: string): RunnerInboxRow | undefined {
  const row = db.prepare('SELECT * FROM runner_inbox WHERE id = ?').get(id) as
    InboxDbRow | undefined;
  return row ? mapInbox(row) : undefined;
}

export function getRunnerSubmissionByKey(
  db: Db,
  idempotencyKey: string,
): RunnerSubmissionResult | undefined {
  const row = db
    .prepare(
      `SELECT i.*, t.id AS turn_id, t.inbox_id AS turn_inbox_id, t.owner_user_id AS turn_owner_user_id,
        t.workspace_jid AS turn_workspace_jid, t.session_id AS turn_session_id, t.status AS turn_status,
        t.available_at AS turn_available_at, t.attempt AS turn_attempt, t.lease_owner AS turn_lease_owner,
        t.lease_expires_at AS turn_lease_expires_at, t.result_text AS turn_result_text, t.error AS turn_error,
        t.created_at AS turn_created_at, t.updated_at AS turn_updated_at, t.started_at AS turn_started_at,
        t.completed_at AS turn_completed_at
       FROM runner_inbox i JOIN runner_turns t ON t.inbox_id = i.id
       WHERE i.idempotency_key = ?`,
    )
    .get(idempotencyKey) as
    | (InboxDbRow & {
        turn_id: string;
        turn_inbox_id: string;
        turn_owner_user_id: string;
        turn_workspace_jid: string;
        turn_session_id: string;
        turn_status: RunnerTurnStatus;
        turn_available_at: string;
        turn_attempt: number;
        turn_lease_owner: string | null;
        turn_lease_expires_at: string | null;
        turn_result_text: string | null;
        turn_error: string | null;
        turn_created_at: string;
        turn_updated_at: string;
        turn_started_at: string | null;
        turn_completed_at: string | null;
      })
    | undefined;
  if (!row) return undefined;
  return {
    created: false,
    inbox: mapInbox(row),
    turn: mapTurn({
      id: row.turn_id,
      inbox_id: row.turn_inbox_id,
      owner_user_id: row.turn_owner_user_id,
      workspace_jid: row.turn_workspace_jid,
      session_id: row.turn_session_id,
      status: row.turn_status,
      available_at: row.turn_available_at,
      attempt: row.turn_attempt,
      lease_owner: row.turn_lease_owner,
      lease_expires_at: row.turn_lease_expires_at,
      result_text: row.turn_result_text,
      error: row.turn_error,
      created_at: row.turn_created_at,
      updated_at: row.turn_updated_at,
      started_at: row.turn_started_at,
      completed_at: row.turn_completed_at,
    }),
  };
}

export function createRunnerSubmission(
  db: Db,
  input: RunnerSubmission,
): RunnerSubmissionResult {
  const key = input.idempotencyKey.trim();
  if (!key) throw new Error('idempotencyKey is required');
  const existing = getRunnerSubmissionByKey(db, key);
  if (existing) return existing;
  const now = isoNow(input.now);
  const inboxId = `in_${crypto.randomUUID()}`;
  const turnId = `turn_${crypto.randomUUID()}`;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO runner_inbox (
        id, owner_user_id, workspace_jid, session_id, idempotency_key, message,
        status, available_at, attempt, error, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, ?, ?, NULL)`,
    ).run(
      inboxId,
      input.ownerUserId,
      input.workspaceJid,
      input.sessionId,
      key,
      input.message,
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO runner_turns (
        id, inbox_id, owner_user_id, workspace_jid, session_id, status,
        available_at, attempt, lease_owner, lease_expires_at, result_text, error,
        created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
    ).run(
      turnId,
      inboxId,
      input.ownerUserId,
      input.workspaceJid,
      input.sessionId,
      now,
      now,
      now,
    );
  })();
  const result = getRunnerSubmissionByKey(db, key);
  if (!result) throw new Error('Failed to create runner submission');
  return { ...result, created: true };
}

export function claimRunnerTurn(
  db: Db,
  turnId: string,
  leaseOwner: string,
  leaseMs: number,
  nowInput?: Date | string,
): RunnerTurnRow | undefined {
  const now = isoNow(nowInput);
  const result = db
    .prepare(
      `UPDATE runner_turns
       SET status = 'running', lease_owner = ?, lease_expires_at = ?,
           attempt = attempt + 1, started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status IN ('queued', 'retry_wait') AND available_at <= ? AND lease_owner IS NULL`,
    )
    .run(leaseOwner, addMs(now, leaseMs), now, now, turnId, now);
  if (result.changes !== 1) return undefined;
  db.prepare(
    `UPDATE runner_inbox SET status = 'processing', attempt = attempt + 1, updated_at = ?
     WHERE id = (SELECT inbox_id FROM runner_turns WHERE id = ?)`,
  ).run(now, turnId);
  return getRunnerTurnById(db, turnId);
}

export function heartbeatRunnerTurn(
  db: Db,
  turnId: string,
  leaseOwner: string,
  leaseMs: number,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  const result = db
    .prepare(
      `UPDATE runner_turns SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?`,
    )
    .run(addMs(now, leaseMs), now, turnId, leaseOwner, now);
  return result.changes === 1;
}

export function appendRunnerOutboxEvent(
  db: Db,
  turnId: string,
  ordinal: number,
  event: unknown,
  nowInput?: Date | string,
): RunnerOutboxRow {
  if (!Number.isInteger(ordinal) || ordinal < 0)
    throw new Error('ordinal must be non-negative');
  const now = isoNow(nowInput);
  const id = `out_${crypto.randomUUID()}`;
  const encoded = JSON.stringify(event);
  if (encoded === undefined) throw new Error('event must be JSON serializable');
  db.prepare(
    `INSERT OR IGNORE INTO runner_outbox
      (id, turn_id, ordinal, event_json, status, created_at, delivered_at)
     VALUES (?, ?, ?, ?, 'pending', ?, NULL)`,
  ).run(id, turnId, ordinal, encoded, now);
  const row = db
    .prepare('SELECT * FROM runner_outbox WHERE turn_id = ? AND ordinal = ?')
    .get(turnId, ordinal) as OutboxDbRow;
  return mapOutbox(row);
}

export function listRunnerOutbox(db: Db, turnId: string): RunnerOutboxRow[] {
  return (
    db
      .prepare('SELECT * FROM runner_outbox WHERE turn_id = ? ORDER BY ordinal ASC')
      .all(turnId) as OutboxDbRow[]
  ).map(mapOutbox);
}

export function markRunnerOutboxDelivered(
  db: Db,
  id: string,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  const result = db
    .prepare(
      `UPDATE runner_outbox SET status = 'delivered', delivered_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(now, id);
  return result.changes === 1;
}

function releaseTurnLease(
  db: Db,
  turnId: string,
  leaseOwner: string,
  status: 'retry_wait' | 'failed',
  error: string,
  availableAt: string,
  now: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE runner_turns SET status = ?, available_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, error = ?, updated_at = ?, completed_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
       WHERE id = ? AND status = 'running' AND lease_owner = ?`,
    )
    .run(
      status,
      availableAt,
      error,
      now,
      status,
      status === 'failed' ? now : null,
      turnId,
      leaseOwner,
    );
  if (result.changes !== 1) return false;
  db.prepare(
    `UPDATE runner_inbox SET status = ?, available_at = ?, error = ?, updated_at = ?,
       completed_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
     WHERE id = (SELECT inbox_id FROM runner_turns WHERE id = ?)`,
  ).run(status, availableAt, error, now, status, status === 'failed' ? now : null, turnId);
  return true;
}

export function retryRunnerTurn(
  db: Db,
  turnId: string,
  leaseOwner: string,
  error: string,
  availableAt: string,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  return releaseTurnLease(db, turnId, leaseOwner, 'retry_wait', error, availableAt, now);
}

export function failRunnerTurn(
  db: Db,
  turnId: string,
  leaseOwner: string,
  error: string,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  return releaseTurnLease(db, turnId, leaseOwner, 'failed', error, now, now);
}

export function completeRunnerTurn(
  db: Db,
  turnId: string,
  leaseOwner: string,
  resultText: string,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  const result = db
    .prepare(
      `UPDATE runner_turns SET status = 'completed', result_text = ?, error = NULL,
       lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ?`,
    )
    .run(resultText, now, now, turnId, leaseOwner);
  if (result.changes !== 1) return false;
  db.prepare(
    `UPDATE runner_inbox SET status = 'completed', completed_at = ?, updated_at = ?, error = NULL
     WHERE id = (SELECT inbox_id FROM runner_turns WHERE id = ?)`,
  ).run(now, now, turnId);
  return true;
}

export function recoverRunnerRuns(db: Db, nowInput?: Date | string): number {
  const now = isoNow(nowInput);
  return db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE runner_turns SET status = 'retry_wait', available_at = ?,
          lease_owner = NULL, lease_expires_at = NULL,
          error = COALESCE(error, 'recovered after lease expiry'), updated_at = ?
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .run(now, now, now);
    db.prepare(
      `UPDATE runner_inbox SET status = 'retry_wait', available_at = ?, updated_at = ?,
        error = COALESCE(error, 'recovered after lease expiry')
       WHERE status = 'processing' AND id IN (
         SELECT inbox_id FROM runner_turns WHERE status = 'retry_wait'
       )`,
    ).run(now, now);
    return result.changes;
  })();
}

export function listRunnableRunnerTurns(db: Db, nowInput?: Date | string): RunnerTurnRow[] {
  const now = isoNow(nowInput);
  return (
    db
      .prepare(
        `SELECT * FROM runner_turns WHERE status IN ('queued', 'retry_wait')
       AND available_at <= ? ORDER BY created_at ASC`,
      )
      .all(now) as TurnDbRow[]
  ).map(mapTurn);
}

export function toRunnerTurnPublic(turn: RunnerTurnRow) {
  return {
    id: turn.id,
    inbox_id: turn.inboxId,
    session_id: turn.sessionId,
    status: turn.status,
    attempt: turn.attempt,
    result: turn.resultText,
    error: turn.error,
    created_at: turn.createdAt,
    updated_at: turn.updatedAt,
    completed_at: turn.completedAt,
  };
}
