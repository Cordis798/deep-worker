import type Database from 'better-sqlite3';
import { getOwnedWorkspace } from './workspaces.js';
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  listMemoryRevisions,
  searchMemories,
  updateMemory,
  MemoryConflictError,
  type MemoryKind,
  type MemoryRow,
} from './memory-store.js';

const KINDS = new Set<MemoryKind>(['fact', 'decision', 'experience', 'follow_up']);
const MAX_CONTENT_LENGTH = 32_768;
const MAX_TITLE_LENGTH = 500;
const MAX_SOURCE_LENGTH = 512;

export class MemoryServiceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_request' | 'revision_conflict',
    message: string,
    public readonly current?: MemoryRow,
  ) {
    super(message);
    this.name = 'MemoryServiceError';
  }
}

export interface MemoryInput {
  workspaceJid: string;
  ownerUserId: string;
  kind: MemoryKind;
  title?: string;
  content: string;
  source?: string;
}

function ensureWorkspace(db: Database.Database, ownerUserId: string, workspaceJid: string): void {
  if (!getOwnedWorkspace(db, ownerUserId, workspaceJid)) {
    throw new MemoryServiceError('not_found', '工作区不存在');
  }
}

function validateText(value: string | undefined, label: string, max: number, required = false): string {
  const text = value?.trim() ?? '';
  if (required && !text) throw new MemoryServiceError('invalid_request', `${label}不能为空`);
  if (text.length > max) throw new MemoryServiceError('invalid_request', `${label}不能超过 ${max} 个字符`);
  return text;
}

function validateKind(kind: MemoryKind): MemoryKind {
  if (!KINDS.has(kind)) throw new MemoryServiceError('invalid_request', '记忆类型无效');
  return kind;
}

export function listWorkspaceMemories(db: Database.Database, ownerUserId: string, workspaceJid: string, kind?: MemoryKind) {
  ensureWorkspace(db, ownerUserId, workspaceJid);
  if (kind) validateKind(kind);
  return listMemories(db, ownerUserId, workspaceJid, kind);
}

export function searchWorkspaceMemories(db: Database.Database, ownerUserId: string, workspaceJid: string, query: string, kind?: MemoryKind) {
  ensureWorkspace(db, ownerUserId, workspaceJid);
  const text = validateText(query, '搜索内容', 500, true);
  if (kind) validateKind(kind);
  return searchMemories(db, ownerUserId, workspaceJid, text, kind);
}

export function getWorkspaceMemory(db: Database.Database, ownerUserId: string, workspaceJid: string, memoryId: string) {
  ensureWorkspace(db, ownerUserId, workspaceJid);
  const memory = getMemory(db, ownerUserId, workspaceJid, memoryId);
  if (!memory) throw new MemoryServiceError('not_found', '记忆不存在');
  return memory;
}

export function createWorkspaceMemory(db: Database.Database, input: MemoryInput) {
  ensureWorkspace(db, input.ownerUserId, input.workspaceJid);
  const kind = validateKind(input.kind);
  const content = validateText(input.content, '记忆内容', MAX_CONTENT_LENGTH, true);
  const title = validateText(input.title, '记忆标题', MAX_TITLE_LENGTH);
  const source = validateText(input.source ?? 'web_user', '来源', MAX_SOURCE_LENGTH, true);
  return createMemory(db, { ...input, kind, content, title, source });
}

export function updateWorkspaceMemory(
  db: Database.Database,
  input: {
    ownerUserId: string;
    workspaceJid: string;
    memoryId: string;
    expectedRevision: number;
    patch: Partial<Pick<MemoryRow, 'kind' | 'title' | 'content' | 'source'>>;
  },
) {
  ensureWorkspace(db, input.ownerUserId, input.workspaceJid);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new MemoryServiceError('invalid_request', 'expectedRevision 必须是正整数');
  }
  const patch = { ...input.patch };
  if (patch.kind) validateKind(patch.kind);
  if (patch.title !== undefined) patch.title = validateText(patch.title, '记忆标题', MAX_TITLE_LENGTH);
  if (patch.content !== undefined) patch.content = validateText(patch.content, '记忆内容', MAX_CONTENT_LENGTH, true);
  if (patch.source !== undefined) patch.source = validateText(patch.source, '来源', MAX_SOURCE_LENGTH, true);
  if (Object.keys(patch).length === 0) throw new MemoryServiceError('invalid_request', '没有可更新的字段');
  try {
    return updateMemory(db, { ...input, patch });
  } catch (error) {
    if (error instanceof MemoryConflictError) {
      throw new MemoryServiceError('revision_conflict', error.message, error.current);
    }
    throw error;
  }
}

export function forgetWorkspaceMemory(
  db: Database.Database,
  input: { ownerUserId: string; workspaceJid: string; memoryId: string; expectedRevision: number },
): boolean {
  ensureWorkspace(db, input.ownerUserId, input.workspaceJid);
  try {
    return deleteMemory(db, input);
  } catch (error) {
    if (error instanceof MemoryConflictError) {
      throw new MemoryServiceError('revision_conflict', error.message, error.current);
    }
    throw error;
  }
}

export function getWorkspaceMemoryRevisions(db: Database.Database, ownerUserId: string, workspaceJid: string, memoryId: string) {
  ensureWorkspace(db, ownerUserId, workspaceJid);
  if (!getMemory(db, ownerUserId, workspaceJid, memoryId)) throw new MemoryServiceError('not_found', '记忆不存在');
  return listMemoryRevisions(db, ownerUserId, workspaceJid, memoryId);
}
