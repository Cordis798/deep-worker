import { describe, expect, it } from 'vitest';
import { initDatabase } from './db/migration.js';
import { effectiveExecutionMode, resolveRequestedExecutionMode } from './execution-policy.js';
import { createUser } from './users.js';
import { createWorkspace } from './workspaces.js';

describe('工作区执行模式策略', () => {
  it('普通成员默认使用 Container 且不能请求 Host', () => {
    const db = initDatabase(':memory:');
    createUser(db, { id: 'member', username: 'member', password_hash: 'x', display_name: '成员', role: 'member', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    expect(resolveRequestedExecutionMode(db, 'member')).toEqual({ ok: true, mode: 'container' });
    expect(resolveRequestedExecutionMode(db, 'member', 'host')).toEqual({ ok: false, reason: 'host_forbidden' });
    const workspace = createWorkspace(db, 'member', { name: '成员工作区' })!;
    expect(workspace.execution_mode).toBe('container');
    db.close();
  });

  it('管理员可以使用 Host，历史不安全记录按 Container 执行', () => {
    const db = initDatabase(':memory:');
    createUser(db, { id: 'admin', username: 'admin', password_hash: 'x', display_name: '管理员', role: 'admin', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const workspace = createWorkspace(db, 'admin', { name: '管理员工作区', execution_mode: 'host' })!;
    expect(effectiveExecutionMode(db, workspace)).toBe('host');
    db.prepare("UPDATE users SET role = 'member' WHERE id = 'admin'").run();
    expect(effectiveExecutionMode(db, workspace)).toBe('container');
    db.close();
  });
});
