import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from './db/migration.js';
import { createWorkspace } from './workspaces.js';
import {
  createMemory,
  getMemory,
  listMemoryRevisions,
  searchMemories,
  updateMemory,
  MemoryConflictError,
} from './memory-store.js';

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(':memory:');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, status, permissions, created_at, updated_at)
     VALUES ('u1', 'u1', 'x', '用户', 'member', 'active', '[]', ?, ?),
            ('u2', 'u2', 'x', '其他用户', 'member', 'active', '[]', ?, ?)`,
  ).run(now, now, now, now);
  createWorkspace(db, 'u1', { jid: 'w1', name: '工作区', folder: 'w1' });
  createWorkspace(db, 'u2', { jid: 'w2', name: '其他工作区', folder: 'w2' });
});

describe('工作区记忆', () => {
  it('保留版本并拒绝过期版本覆盖', () => {
    const memory = createMemory(db, {
      ownerUserId: 'u1', workspaceJid: 'w1', kind: 'fact', title: '主题', content: '初始内容', source: 'web_user',
    });
    const updated = updateMemory(db, {
      ownerUserId: 'u1', workspaceJid: 'w1', memoryId: memory.id, expectedRevision: 1,
      patch: { content: '新内容' },
    });
    expect(updated.revision).toBe(2);
    expect(listMemoryRevisions(db, 'u1', 'w1', memory.id)).toHaveLength(2);
    expect(() => updateMemory(db, {
      ownerUserId: 'u1', workspaceJid: 'w1', memoryId: memory.id, expectedRevision: 1,
      patch: { content: '冲突内容' },
    })).toThrow(MemoryConflictError);
  });

  it('搜索限定在当前工作区', () => {
    createMemory(db, { ownerUserId: 'u1', workspaceJid: 'w1', kind: 'decision', title: '发布策略', content: '周五发布', source: 'web_user' });
    createMemory(db, { ownerUserId: 'u2', workspaceJid: 'w2', kind: 'decision', title: '发布策略', content: '不应泄露', source: 'web_user' });
    const hits = searchMemories(db, 'u1', 'w1', '发布');
    expect(hits).toHaveLength(1);
    expect(getMemory(db, 'u1', 'w1', hits[0]!.id)?.content).toBe('周五发布');
    expect(getMemory(db, 'u1', 'w1', 'missing')).toBeUndefined();
  });
});
