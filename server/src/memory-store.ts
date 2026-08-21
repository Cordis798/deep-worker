import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export type MemoryKind = 'fact' | 'decision' | 'experience' | 'follow_up';

export interface MemoryRow {
  id: string;
  workspace_jid: string;
  owner_user_id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  source: string;
  revision: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MemoryRevisionRow {
  id: string;
  memory_id: string;
  revision: number;
  kind: MemoryKind;
  title: string;
  content: string;
  source: string;
  content_hash: string;
  actor_user_id: string;
  created_at: string;
}

export class MemoryConflictError extends Error {
  constructor(public readonly current: MemoryRow | undefined) {
    super('记忆版本已变化，请刷新后重试');
    this.name = 'MemoryConflictError';
  }
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hash(value: { kind: string; title: string; content: string; source: string }): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

function mapMemory(row: unknown): MemoryRow {
  return row as MemoryRow;
}

function mapRevision(row: unknown): MemoryRevisionRow {
  return row as MemoryRevisionRow;
}

export function getMemory(db: Database.Database, ownerUserId: string, workspaceJid: string, memoryId: string): MemoryRow | undefined {
  return mapMemory(db.prepare(
    `SELECT * FROM workspace_memories WHERE id = ? AND owner_user_id = ?
     AND workspace_jid = ? AND deleted_at IS NULL`,
  ).get(memoryId, ownerUserId, workspaceJid));
}

export function listMemories(
  db: Database.Database,
  ownerUserId: string,
  workspaceJid: string,
  kind?: MemoryKind,
): MemoryRow[] {
  const params: unknown[] = [ownerUserId, workspaceJid];
  const kindClause = kind ? ' AND kind = ?' : '';
  if (kind) params.push(kind);
  return db.prepare(
    `SELECT * FROM workspace_memories WHERE owner_user_id = ? AND workspace_jid = ?
     AND deleted_at IS NULL${kindClause} ORDER BY updated_at DESC, id DESC`,
  ).all(...params).map(mapMemory);
}

export function searchMemories(
  db: Database.Database,
  ownerUserId: string,
  workspaceJid: string,
  query: string,
  kind?: MemoryKind,
): MemoryRow[] {
  const escaped = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  const params: unknown[] = [ownerUserId, workspaceJid, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`];
  const kindClause = kind ? ' AND kind = ?' : '';
  if (kind) params.push(kind);
  return db.prepare(
    `SELECT * FROM workspace_memories WHERE owner_user_id = ? AND workspace_jid = ?
     AND deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')
     ${kindClause} ORDER BY updated_at DESC, id DESC LIMIT 100`,
  ).all(...params).map(mapMemory);
}

export function createMemory(
  db: Database.Database,
  input: {
    ownerUserId: string;
    workspaceJid: string;
    kind: MemoryKind;
    title: string;
    content: string;
    source: string;
  },
): MemoryRow {
  const memoryId = id('memory');
  const timestamp = now();
  const contentHash = hash(input);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO workspace_memories
       (id, workspace_jid, owner_user_id, kind, title, content, source, revision, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(memoryId, input.workspaceJid, input.ownerUserId, input.kind, input.title, input.content, input.source, contentHash, timestamp, timestamp);
    db.prepare(
      `INSERT INTO memory_revisions
       (id, memory_id, revision, kind, title, content, source, content_hash, actor_user_id, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id('memory_revision'), memoryId, input.kind, input.title, input.content, input.source, contentHash, input.ownerUserId, timestamp);
  })();
  return getMemory(db, input.ownerUserId, input.workspaceJid, memoryId)!;
}

export function updateMemory(
  db: Database.Database,
  input: {
    ownerUserId: string;
    workspaceJid: string;
    memoryId: string;
    expectedRevision: number;
    patch: Partial<Pick<MemoryRow, 'kind' | 'title' | 'content' | 'source'>>;
  },
): MemoryRow {
  const current = getMemory(db, input.ownerUserId, input.workspaceJid, input.memoryId);
  if (!current || current.revision !== input.expectedRevision) throw new MemoryConflictError(current);
  const next = {
    kind: input.patch.kind ?? current.kind,
    title: input.patch.title ?? current.title,
    content: input.patch.content ?? current.content,
    source: input.patch.source ?? current.source,
  };
  const timestamp = now();
  const nextRevision = current.revision + 1;
  const contentHash = hash(next);
  const result = db.transaction(() => {
    const changed = db.prepare(
      `UPDATE workspace_memories SET kind = ?, title = ?, content = ?, source = ?,
       revision = ?, content_hash = ?, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND workspace_jid = ? AND revision = ? AND deleted_at IS NULL`,
    ).run(next.kind, next.title, next.content, next.source, nextRevision, contentHash, timestamp, input.memoryId, input.ownerUserId, input.workspaceJid, input.expectedRevision);
    if (changed.changes !== 1) throw new MemoryConflictError(getMemory(db, input.ownerUserId, input.workspaceJid, input.memoryId));
    db.prepare(
      `INSERT INTO memory_revisions
       (id, memory_id, revision, kind, title, content, source, content_hash, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id('memory_revision'), input.memoryId, nextRevision, next.kind, next.title, next.content, next.source, contentHash, input.ownerUserId, timestamp);
  })();
  void result;
  return getMemory(db, input.ownerUserId, input.workspaceJid, input.memoryId)!;
}

export function deleteMemory(
  db: Database.Database,
  input: { ownerUserId: string; workspaceJid: string; memoryId: string; expectedRevision: number },
): boolean {
  const current = getMemory(db, input.ownerUserId, input.workspaceJid, input.memoryId);
  if (!current || current.revision !== input.expectedRevision) throw new MemoryConflictError(current);
  const timestamp = now();
  const result = db.prepare(
    `UPDATE workspace_memories SET deleted_at = ?, revision = revision + 1, updated_at = ?
     WHERE id = ? AND owner_user_id = ? AND workspace_jid = ? AND revision = ? AND deleted_at IS NULL`,
  ).run(timestamp, timestamp, input.memoryId, input.ownerUserId, input.workspaceJid, input.expectedRevision);
  return result.changes === 1;
}

export function listMemoryRevisions(
  db: Database.Database,
  ownerUserId: string,
  workspaceJid: string,
  memoryId: string,
): MemoryRevisionRow[] {
  const memory = db.prepare(
    'SELECT 1 FROM workspace_memories WHERE id = ? AND owner_user_id = ? AND workspace_jid = ?',
  ).get(memoryId, ownerUserId, workspaceJid);
  if (!memory) return [];
  return db.prepare('SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision DESC').all(memoryId).map(mapRevision);
}

export { hash as memoryContentHash };
