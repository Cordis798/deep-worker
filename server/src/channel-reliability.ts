import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export type Db = Database.Database;
export type ChannelDeliveryKind = 'message' | 'file' | 'image' | 'reaction';
export type ChannelDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface ChannelDeliveryPayload {
  text?: string;
  filePath?: string;
  fileName?: string;
  dataBase64?: string;
  mimeType?: string;
  caption?: string;
  reaction?: string;
}

export interface ChannelOutboxRow {
  id: string;
  ownerUserId: string;
  provider: string;
  channelAccountId: string;
  chatJid: string;
  sourceMessageId: string | null;
  kind: ChannelDeliveryKind;
  payload: ChannelDeliveryPayload;
  status: ChannelDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

interface ChannelOutboxDbRow {
  id: string;
  owner_user_id: string;
  provider: string;
  channel_account_id: string;
  chat_jid: string;
  source_message_id: string | null;
  kind: ChannelDeliveryKind;
  payload_json: string;
  status: ChannelDeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

function mapRow(row: ChannelOutboxDbRow): ChannelOutboxRow {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    provider: row.provider,
    channelAccountId: row.channel_account_id,
    chatJid: row.chat_jid,
    sourceMessageId: row.source_message_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as ChannelDeliveryPayload,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

export function enqueueChannelDelivery(db: Db, input: {
  ownerUserId: string;
  provider: string;
  channelAccountId: string;
  chatJid: string;
  sourceMessageId?: string;
  kind: ChannelDeliveryKind;
  payload: ChannelDeliveryPayload;
  now?: Date;
}): ChannelOutboxRow {
  const now = (input.now ?? new Date()).toISOString();
  const id = `co_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO channel_outbox (
      id, owner_user_id, provider, channel_account_id, chat_jid, source_message_id,
      kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).run(id, input.ownerUserId, input.provider, input.channelAccountId, input.chatJid, input.sourceMessageId ?? null, input.kind, JSON.stringify(input.payload), now, now, now);
  return mapRow(db.prepare('SELECT * FROM channel_outbox WHERE id = ?').get(id) as ChannelOutboxDbRow);
}

export function listReadyChannelDeliveries(db: Db, now = new Date()): ChannelOutboxRow[] {
  return (db.prepare("SELECT * FROM channel_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at ASC").all(now.toISOString()) as ChannelOutboxDbRow[]).map(mapRow);
}

export function markChannelDeliveryDelivered(db: Db, id: string, now = new Date()): void {
  const timestamp = now.toISOString();
  db.prepare("UPDATE channel_outbox SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, id);
}

export function retryChannelDelivery(db: Db, id: string, error: string, retryAt: Date, maxAttempts: number): ChannelOutboxRow | undefined {
  const row = db.prepare('SELECT * FROM channel_outbox WHERE id = ?').get(id) as ChannelOutboxDbRow | undefined;
  if (!row) return undefined;
  const attempts = row.attempts + 1;
  const status = attempts >= maxAttempts ? 'failed' : 'pending';
  const now = new Date().toISOString();
  db.prepare('UPDATE channel_outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, attempts, retryAt.toISOString(), error, now, id);
  return mapRow(db.prepare('SELECT * FROM channel_outbox WHERE id = ?').get(id) as ChannelOutboxDbRow);
}
