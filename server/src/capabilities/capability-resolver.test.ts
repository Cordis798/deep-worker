import { describe, expect, it } from 'vitest';
import { applyCapabilityGovernance, resolveCapabilitiesForWorkspace, resolveCapabilitiesFromDatabase, resolveEffectiveCapabilities, restrictCapabilityManifestForTask, trimCapabilityManifest, type SkillCandidate } from './capability-resolver.js';
import { resolveCapabilityGovernance } from './capability-governance.js';
import { initDatabase } from '../db/migration.js';
import { createWorkspace } from '../workspaces.js';
import { createMcpServer } from './mcp-store.js';

const skill = (candidate: Partial<SkillCandidate> & Pick<SkillCandidate, 'id' | 'name' | 'scope'>): SkillCandidate => ({
  enabled: true,
  path: `/skills/${candidate.id}`,
  contentHash: `hash-${candidate.id}`,
  dependencies: [],
  ...candidate,
});

describe('生效能力解析', () => {
  it('按系统、用户、项目顺序覆盖同名 Skill，并生成稳定 hash', () => {
    const input = {
      skills: [skill({ id: 'system-a', name: 'same', scope: 'system' }), skill({ id: 'user-a', name: 'same', scope: 'user' }), skill({ id: 'project-a', name: 'same', scope: 'project' })],
      mcpServers: [],
      plugins: [],
    };
    const first = resolveEffectiveCapabilities(input);
    const second = resolveEffectiveCapabilities({ ...input, skills: [...input.skills].reverse() });
    expect(first.skills.selected).toHaveLength(1);
    expect(first.skills.selected[0]).toMatchObject({ id: 'project-a', name: 'same', source: 'project', overrides: ['system', 'user'] });
    expect(first.hash).toBe(second.hash);
  });

  it('精确选择禁用、缺失和依赖缺失的 Skill 时失败', () => {
    const disabled = skill({ id: 'disabled', name: 'disabled', scope: 'user', enabled: false });
    expect(() => resolveEffectiveCapabilities({ skills: [disabled], mcpServers: [], plugins: [], selectedSkillIds: ['disabled'] })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DISABLED' }));
    expect(() => resolveEffectiveCapabilities({ skills: [], mcpServers: [], plugins: [], selectedSkillIds: ['missing'] })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_NOT_FOUND' }));
    expect(() => resolveEffectiveCapabilities({ skills: [skill({ id: 'needs', name: 'needs', scope: 'user', dependencies: ['base'] })], mcpServers: [], plugins: [] })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_MISSING_DEPENDENCY' }));
  });

  it('解析 MCP、Plugins 并支持预览动态裁剪', () => {
    const manifest = resolveEffectiveCapabilities({
      skills: [skill({ id: 'one', name: 'one', scope: 'user' }), skill({ id: 'two', name: 'two', scope: 'user' })],
      mcpServers: [{ id: 'mcp-1', name: 'demo', enabled: true, transport: 'http' }],
      plugins: [{ id: 'plugin-1', name: 'demo-plugin', version: '1.0.0', enabled: true }],
    });
    const trimmed = trimCapabilityManifest(manifest, { maxSkills: 1, maxMcpServers: 0, maxPlugins: 0 });
    expect(trimmed.skills.selected).toHaveLength(1);
    expect(trimmed.mcp.selected).toHaveLength(0);
    expect(trimmed.plugins.selected).toHaveLength(0);
    expect(trimmed.hash).not.toBe(manifest.hash);
  });

  it('按路由任务能力裁剪运行时工具，避免注入整个工作区清单', () => {
    const manifest = resolveEffectiveCapabilities({
      skills: [skill({ id: 'one', name: 'one', scope: 'user' })],
      mcpServers: [
        { id: 'git', name: 'git', enabled: true, transport: 'http' },
        { id: 'release', name: 'release', enabled: true, transport: 'http' },
      ],
      plugins: [
        { id: 'ci', name: 'ci', version: '1.0.0', enabled: true },
        { id: 'incident', name: 'incident', version: '1.0.0', enabled: true },
      ],
    });
    const scoped = restrictCapabilityManifestForTask(manifest, ['code']);
    expect(scoped.skills.selected).toHaveLength(1);
    expect(scoped.mcp.selected.map((item) => item.name)).toEqual(['git']);
    expect(scoped.plugins.selected.map((item) => item.name)).toEqual(['ci']);
    expect(scoped.hash).not.toBe(manifest.hash);
  });

  it('在能力解析后执行岗位能力包的冲突与越权检查', () => {
    const manifest = resolveEffectiveCapabilities({
      skills: [skill({ id: 'bash', name: 'bash', scope: 'system' })],
      mcpServers: [{ id: 'mcp-1', name: 'git', enabled: true, transport: 'http' }],
      plugins: [],
    });
    const governed = resolveCapabilityGovernance({ jobRole: 'engineering' });
    expect(resolveEffectiveCapabilities({
      skills: manifest.skills.selected.map((item) => skill({ id: item.id, name: item.name, scope: item.source })),
      mcpServers: manifest.mcp.selected,
      plugins: manifest.plugins.selected,
    })).toBeTruthy();
    expect(() => {
      // 研发能力包不允许销售 CRM MCP，越权必须显式失败。
      const salesMcp = { id: 'mcp-crm', name: 'crm', enabled: true, transport: 'http' as const };
      applyCapabilityGovernance({ ...manifest, mcp: { selected: [salesMcp] } }, governed);
    }).toThrowError(expect.objectContaining({ code: 'CAPABILITY_FORBIDDEN' }));
  });

  it('按工作区成员岗位解析能力并写入审计记录', () => {
    const db = initDatabase(':memory:');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, status, permissions, created_at, updated_at)
       VALUES ('owner', 'owner', 'x', 'admin', 'active', '[]', ?, ?)`,
    ).run(now, now);
    const workspace = createWorkspace(db, 'owner', { name: '审计工作区' })!;
    db.prepare(
      `UPDATE workspace_members SET job_role = 'engineering', capability_package = 'engineering'
       WHERE workspace_jid = ? AND user_id = 'owner'`,
    ).run(workspace.jid);
    const manifest = resolveCapabilitiesForWorkspace(db, 'owner', workspace.jid);
    expect(manifest.governance).toMatchObject({ jobRole: 'engineering', packageId: 'engineering' });
    expect(db.prepare('SELECT decision FROM capability_resolution_audit WHERE workspace_jid = ?').get(workspace.jid)).toEqual({ decision: 'allowed' });
    db.close();
  });

  it('公开解析不携带 MCP 密文，运行时解析才恢复连接配置', () => {
    const db = initDatabase(':memory:');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, status, permissions, created_at, updated_at)
       VALUES ('owner', 'owner', 'x', 'admin', 'active', '[]', ?, ?)`,
    ).run(now, now);
    createMcpServer(db, 'owner', { name: 'data-api', transport: 'http', url: 'https://example.test', credentials: { token: 'secret' } });
    const publicManifest = resolveCapabilitiesFromDatabase(db, 'owner');
    expect(publicManifest.mcp.selected[0]).not.toHaveProperty('credentials');
    expect(publicManifest.mcp.selected[0]).not.toHaveProperty('url');
    const runtimeManifest = resolveCapabilitiesFromDatabase(db, 'owner', { includeRuntimeConfig: true });
    expect(runtimeManifest.mcp.selected[0]).toMatchObject({ url: 'https://example.test', credentials: { token: 'secret' } });
    db.close();
  });

  it('工作区出现未知能力包时拒绝并写入 denied 审计', () => {
    const db = initDatabase(':memory:');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, status, permissions, created_at, updated_at)
       VALUES ('owner', 'owner', 'x', 'admin', 'active', '[]', ?, ?)`,
    ).run(now, now);
    const workspace = createWorkspace(db, 'owner', { name: '脏数据工作区' })!;
    db.prepare(
      `UPDATE workspace_members SET job_role = 'engineering', capability_package = 'unknown'
       WHERE workspace_jid = ? AND user_id = 'owner'`,
    ).run(workspace.jid);
    expect(() => resolveCapabilitiesForWorkspace(db, 'owner', workspace.jid)).toThrowError(expect.objectContaining({ code: 'CAPABILITY_GOVERNANCE_INVALID' }));
    expect(db.prepare('SELECT decision, job_role, capability_package FROM capability_resolution_audit WHERE workspace_jid = ?').get(workspace.jid)).toEqual({ decision: 'denied', job_role: 'engineering', capability_package: 'unknown' });
    db.close();
  });
});
