import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { buildBuiltinManifest, listSkills, type SkillRow } from './skill-store.js';
import { listMcpServers, type McpServerRow } from './mcp-store.js';
import { listPlugins, type PluginRow } from './plugin-catalog.js';

export type CapabilityScope = 'system' | 'user' | 'project';

export interface SkillCandidate {
  id: string;
  name: string;
  scope: CapabilityScope;
  path: string;
  contentHash: string;
  dependencies: string[];
  enabled: boolean;
}

export interface McpCandidate {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
}

export interface PluginCandidate {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}

export interface EffectiveSkill {
  id: string;
  name: string;
  source: CapabilityScope;
  path: string;
  contentHash: string;
  dependencies: string[];
  overrides: CapabilityScope[];
}

export interface CapabilityManifest {
  schemaVersion: 1;
  hash: string;
  skills: {
    selected: EffectiveSkill[];
    candidates: Array<SkillCandidate & { selected: boolean; excludedReason?: 'disabled' | 'profile_filtered' | 'shadowed' }>;
    conflicts: string[];
  };
  mcp: { selected: McpCandidate[] };
  plugins: { selected: PluginCandidate[] };
}

export class CapabilityResolverError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CapabilityResolverError';
  }
}

function priority(scope: CapabilityScope): number {
  return scope === 'system' ? 0 : scope === 'user' ? 1 : 2;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}

function computeHash(input: Omit<CapabilityManifest, 'hash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(input))).digest('hex');
}

function skillCandidates(input: { skills: SkillCandidate[]; selectedSkillIds?: string[] }): CapabilityManifest['skills'] {
  type CandidateState = SkillCandidate & { selected: boolean; excludedReason?: 'disabled' | 'profile_filtered' | 'shadowed' };
  const requested = input.selectedSkillIds === undefined ? undefined : new Set(input.selectedSkillIds);
  const known = new Map(input.skills.map((candidate) => [candidate.id, candidate]));
  if (requested) {
    for (const id of requested) {
      const candidate = known.get(id);
      if (!candidate) throw new CapabilityResolverError('CAPABILITY_NOT_FOUND', `Skill 不存在：${id}`);
      if (!candidate.enabled) throw new CapabilityResolverError('CAPABILITY_DISABLED', `Skill 已禁用：${id}`);
    }
  }
  const candidates: CandidateState[] = input.skills.map((candidate) => ({
    ...candidate,
    selected: false,
    ...(!candidate.enabled ? { excludedReason: 'disabled' as const } : requested && !requested.has(candidate.id) ? { excludedReason: 'profile_filtered' as const } : {}),
  }));
  const byName = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    if (!candidate.enabled || candidate.excludedReason) continue;
    const group = byName.get(candidate.name) ?? [];
    group.push(candidate);
    byName.set(candidate.name, group);
  }
  const selected: EffectiveSkill[] = [];
  const conflicts: string[] = [];
  for (const [name, group] of byName) {
    group.sort((left, right) => priority(left.scope) - priority(right.scope) || left.id.localeCompare(right.id));
    const winner = group[group.length - 1];
    winner.selected = true;
    for (const shadowed of group.slice(0, -1)) shadowed.excludedReason = 'shadowed';
    if (group.length > 1) conflicts.push(name);
    selected.push({ id: winner.id, name: winner.name, source: winner.scope, path: winner.path, contentHash: winner.contentHash, dependencies: [...winner.dependencies].sort(), overrides: group.slice(0, -1).map((item) => item.scope) });
  }
  selected.sort((left, right) => left.name.localeCompare(right.name));
  conflicts.sort();
  const names = new Set(selected.flatMap((item) => [item.name, ...item.dependencies]));
  for (const item of selected) {
    for (const dependency of item.dependencies) {
      if (!names.has(dependency) || !selected.some((candidate) => candidate.name === dependency)) throw new CapabilityResolverError('CAPABILITY_MISSING_DEPENDENCY', `Skill 依赖缺失：${item.name} -> ${dependency}`);
    }
  }
  candidates.sort((left, right) => left.name.localeCompare(right.name) || priority(left.scope) - priority(right.scope) || left.id.localeCompare(right.id));
  return { selected, candidates, conflicts };
}

function mcpCandidates(input: { mcpServers: McpCandidate[]; selectedMcpIds?: string[] }): McpCandidate[] {
  const selected = input.selectedMcpIds === undefined ? input.mcpServers.filter((server) => server.enabled) : input.selectedMcpIds.map((id) => {
    const server = input.mcpServers.find((item) => item.id === id);
    if (!server) throw new CapabilityResolverError('CAPABILITY_NOT_FOUND', `MCP Server 不存在：${id}`);
    if (!server.enabled) throw new CapabilityResolverError('CAPABILITY_DISABLED', `MCP Server 已禁用：${id}`);
    return server;
  });
  return [...selected].sort((left, right) => left.id.localeCompare(right.id));
}

function pluginCandidates(input: { plugins: PluginCandidate[]; selectedPluginIds?: string[] }): PluginCandidate[] {
  const selected = input.selectedPluginIds === undefined ? input.plugins.filter((plugin) => plugin.enabled) : input.selectedPluginIds.map((id) => {
    const plugin = input.plugins.find((item) => item.id === id);
    if (!plugin) throw new CapabilityResolverError('CAPABILITY_NOT_FOUND', `Plugin 不存在：${id}`);
    if (!plugin.enabled) throw new CapabilityResolverError('CAPABILITY_DISABLED', `Plugin 已禁用：${id}`);
    return plugin;
  });
  return [...selected].sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveEffectiveCapabilities(input: { skills: SkillCandidate[]; mcpServers: McpCandidate[]; plugins: PluginCandidate[]; selectedSkillIds?: string[]; selectedMcpIds?: string[]; selectedPluginIds?: string[] }): CapabilityManifest {
  const skills = skillCandidates(input);
  const mcp = { selected: mcpCandidates(input) };
  const plugins = { selected: pluginCandidates(input) };
  const withoutHash = { schemaVersion: 1 as const, skills, mcp, plugins };
  return { ...withoutHash, hash: computeHash(withoutHash) };
}

function toSkillCandidate(row: SkillRow): SkillCandidate {
  return { id: row.id, name: row.name, scope: row.scope, path: row.install_path, contentHash: row.content_hash, dependencies: JSON.parse(row.dependencies_json) as string[], enabled: row.enabled };
}

function toMcpCandidate(row: McpServerRow): McpCandidate {
  return { id: row.id, name: row.name, transport: row.transport, enabled: row.enabled };
}

function toPluginCandidate(row: PluginRow): PluginCandidate {
  return { id: row.id, name: row.name, version: row.version, enabled: row.enabled };
}

export function resolveCapabilitiesFromDatabase(db: Database.Database, ownerUserId: string, options: { projectKey?: string; builtinRoot?: string; selectedSkillIds?: string[]; selectedMcpIds?: string[]; selectedPluginIds?: string[] } = {}): CapabilityManifest {
  const builtin = buildBuiltinManifest(options.builtinRoot).map((item) => ({ id: `builtin:${item.name}`, name: item.name, scope: 'system' as const, path: item.path, contentHash: item.contentHash, dependencies: [], enabled: true }));
  return resolveEffectiveCapabilities({ skills: [...builtin, ...listSkills(db, { ownerUserId, projectKey: options.projectKey }).map(toSkillCandidate)], mcpServers: listMcpServers(db, ownerUserId).map(toMcpCandidate), plugins: listPlugins(db, ownerUserId).map(toPluginCandidate), selectedSkillIds: options.selectedSkillIds, selectedMcpIds: options.selectedMcpIds, selectedPluginIds: options.selectedPluginIds });
}

export function trimCapabilityManifest(manifest: CapabilityManifest, limits: { maxSkills?: number; maxMcpServers?: number; maxPlugins?: number }): CapabilityManifest {
  const skills = { ...manifest.skills, selected: manifest.skills.selected.slice(0, Math.max(0, limits.maxSkills ?? manifest.skills.selected.length)) };
  const mcp = { selected: manifest.mcp.selected.slice(0, Math.max(0, limits.maxMcpServers ?? manifest.mcp.selected.length)) };
  const plugins = { selected: manifest.plugins.selected.slice(0, Math.max(0, limits.maxPlugins ?? manifest.plugins.selected.length)) };
  const withoutHash = { schemaVersion: 1 as const, skills, mcp, plugins };
  return { ...withoutHash, hash: computeHash(withoutHash) };
}
