import { describe, expect, it } from 'vitest';
import { initDatabase } from './db/migration.js';
import {
  canWorkspaceAction,
  getWorkspaceAccess,
  listAccessibleWorkspaces,
  type WorkspaceAction,
} from './workspace-acl.js';
import { createWorkspace } from './workspaces.js';

function fixture() {
  const db = initDatabase(':memory:');
  const now = new Date().toISOString();
  const users = [
    ['admin', 'admin'],
    ['member', 'member'],
    ['viewer', 'member'],
    ['outsider', 'member'],
  ];
  for (const [id, role] of users) {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, status, permissions, created_at, updated_at)
       VALUES (?, ?, 'x', ?, 'active', '[]', ?, ?)`,
    ).run(id, id, role, now, now);
  }
  db.prepare(
    `INSERT INTO workspaces (jid, folder, owner_user_id, name, status, execution_mode, is_home, created_at, updated_at)
     VALUES ('ws-1', 'ws-1', 'admin', '共享', 'active', 'container', 0, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO workspace_members (workspace_jid, user_id, role, status, invited_by, created_at, updated_at)
     VALUES ('ws-1', 'admin', 'workspace_admin', 'active', 'admin', ?, ?),
            ('ws-1', 'member', 'member', 'active', 'admin', ?, ?),
            ('ws-1', 'viewer', 'viewer', 'active', 'admin', ?, ?)`,
  ).run(now, now, now, now, now, now);
  return db;
}

describe('workspace ACL', () => {
  it('separates visibility, conversation and management permissions', () => {
    const db = fixture();
    const matrix: Array<[string, WorkspaceAction, boolean]> = [
      ['admin', 'view', true],
      ['admin', 'converse', true],
      ['admin', 'manage', true],
      ['member', 'view', true],
      ['member', 'converse', true],
      ['member', 'manage', false],
      ['viewer', 'view', true],
      ['viewer', 'converse', false],
      ['viewer', 'manage', false],
      ['outsider', 'view', false],
    ];
    for (const [userId, action, expected] of matrix) {
      expect(canWorkspaceAction(db, userId, 'ws-1', action)).toBe(expected);
    }
    db.close();
  });

  it('returns a four-principal access context and hides inaccessible workspaces', () => {
    const db = fixture();
    expect(getWorkspaceAccess(db, 'member', 'ws-1')).toMatchObject({
      actorUserId: 'member',
      workspaceOwnerUserId: 'admin',
      credentialPrincipalId: 'admin',
      billingPrincipalId: 'admin',
      role: 'member',
    });
    expect(getWorkspaceAccess(db, 'outsider', 'ws-1')).toBeUndefined();
    expect(listAccessibleWorkspaces(db, 'viewer').map((row) => row.jid)).toEqual(['ws-1']);
    db.close();
  });

  it('adds the creator as a workspace administrator at creation time', () => {
    const db = fixture();
    const row = createWorkspace(db, 'admin', { name: '新工作区' });
    expect(row).toBeTruthy();
    expect(
      db
        .prepare('SELECT role, status FROM workspace_members WHERE workspace_jid = ? AND user_id = ?')
        .get(row!.jid, 'admin'),
    ).toEqual({ role: 'workspace_admin', status: 'active' });
    db.close();
  });
});
