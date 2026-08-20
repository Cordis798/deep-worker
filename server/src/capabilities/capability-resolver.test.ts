import { describe, expect, it } from 'vitest';
import { resolveEffectiveCapabilities, trimCapabilityManifest, type SkillCandidate } from './capability-resolver.js';

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
});
