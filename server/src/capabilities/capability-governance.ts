import crypto from 'node:crypto';

export type JobRole = 'general' | 'engineering' | 'operations' | 'sales';
export type GovernedResource = 'skill' | 'mcp' | 'plugin';

const TASK_RESOURCE_ALIASES: Record<string, Partial<Record<Exclude<GovernedResource, 'skill'>, string[]>>> = {
  code: { mcp: ['git', 'github'], plugin: ['code-review', 'ci'] },
  git: { mcp: ['git', 'github'] },
  test: { plugin: ['ci'] },
  deploy: { mcp: ['release'], plugin: ['release'] },
  monitor: { mcp: ['monitoring'] },
  logs: { mcp: ['logs'] },
  crm: { mcp: ['crm'], plugin: ['crm'] },
  email: { mcp: ['email'], plugin: ['mail'] },
};

export interface CapabilityPackage {
  id: string;
  jobRole: JobRole;
  name: string;
  /** Router 使用的抽象任务能力，* 表示允许全部任务能力。 */
  taskCapabilities: string[];
  /** 使用资源名称匹配，* 表示该资源类型全部允许。 */
  allow: Partial<Record<GovernedResource, string[]>>;
  deny?: Partial<Record<GovernedResource, string[]>>;
  priority: number;
}

export interface CapabilityGovernance {
  schemaVersion: 1;
  jobRole: JobRole;
  packageId: string;
  packageName: string;
  taskCapabilities: string[];
  grants: Array<{ resource: GovernedResource; name: string; action: 'use' }>;
  denials: Array<{ resource: GovernedResource; name: string; action: 'use' }>;
  conflicts: string[];
  hash: string;
}

export const BUILTIN_CAPABILITY_PACKAGES: readonly CapabilityPackage[] = [
  {
    id: 'general',
    jobRole: 'general',
    name: '通用协作',
    taskCapabilities: ['*'],
    allow: { skill: ['*'], mcp: ['*'], plugin: ['*'] },
    priority: 0,
  },
  {
    id: 'engineering',
    jobRole: 'engineering',
    name: '研发能力包',
    taskCapabilities: ['code', 'git', 'test'],
    allow: { skill: ['*'], mcp: ['git', 'github'], plugin: ['code-review', 'ci'] },
    priority: 10,
  },
  {
    id: 'operations',
    jobRole: 'operations',
    name: '运维能力包',
    taskCapabilities: ['deploy', 'monitor', 'logs'],
    allow: { skill: ['*'], mcp: ['monitoring', 'logs', 'release'], plugin: ['incident', 'release'] },
    priority: 10,
  },
  {
    id: 'sales',
    jobRole: 'sales',
    name: '销售能力包',
    taskCapabilities: ['crm', 'email'],
    allow: { skill: ['*'], mcp: ['crm', 'email'], plugin: ['crm', 'mail'] },
    priority: 10,
  },
];

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function normalizeRole(value: string | undefined): JobRole {
  return value === 'engineering' || value === 'operations' || value === 'sales' ? value : 'general';
}

export function getCapabilityPackage(packageId: string | undefined, jobRole?: string): CapabilityPackage {
  const role = normalizeRole(jobRole);
  return BUILTIN_CAPABILITY_PACKAGES.find((item) => item.id === packageId && item.jobRole === role)
    ?? BUILTIN_CAPABILITY_PACKAGES.find((item) => item.id === role)
    ?? BUILTIN_CAPABILITY_PACKAGES[0];
}

export function resolveCapabilityGovernance(input: {
  jobRole?: string;
  packageId?: string;
  additionalAllow?: Partial<Record<GovernedResource, string[]>>;
  deny?: Partial<Record<GovernedResource, string[]>>;
} = {}): CapabilityGovernance {
  const pkg = getCapabilityPackage(input.packageId, input.jobRole);
  const conflicts: string[] = [];
  const grants: CapabilityGovernance['grants'] = [];
  const denials: CapabilityGovernance['denials'] = [];
  for (const resource of ['skill', 'mcp', 'plugin'] as const) {
    const allow = new Set([...(pkg.allow[resource] ?? []), ...(input.additionalAllow?.[resource] ?? [])]);
    const deny = new Set([...(pkg.deny?.[resource] ?? []), ...(input.deny?.[resource] ?? [])]);
    for (const name of deny) denials.push({ resource, name, action: 'use' });
    if (allow.has('*')) for (const name of deny) conflicts.push(`${resource}:${name}`);
    for (const name of allow) {
      if (deny.has(name)) {
        conflicts.push(`${resource}:${name}`);
        continue;
      }
      grants.push({ resource, name, action: 'use' });
    }
  }
  grants.sort((a, b) => a.resource.localeCompare(b.resource) || a.name.localeCompare(b.name));
  denials.sort((a, b) => a.resource.localeCompare(b.resource) || a.name.localeCompare(b.name));
  const withoutHash = {
    schemaVersion: 1 as const,
    jobRole: pkg.jobRole,
    packageId: pkg.id,
    packageName: pkg.name,
    taskCapabilities: [...new Set(pkg.taskCapabilities)].sort(),
    grants,
    denials,
    conflicts: [...conflicts].sort(),
  };
  return { ...withoutHash, hash: hash(withoutHash) };
}

export function isTaskCapabilityAllowed(governance: CapabilityGovernance, capability: string): boolean {
  const normalized = capability.trim().toLowerCase();
  if (!normalized) return false;
  return governance.taskCapabilities.some((item) => item === '*' || item.toLowerCase() === normalized);
}

export function isTaskResourceAllowed(taskCapabilities: readonly string[], resource: Exclude<GovernedResource, 'skill'>, name: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  if (!normalizedName) return false;
  return taskCapabilities.some((capability) => {
    const normalized = capability.trim().toLowerCase();
    if (normalized === '*') return true;
    if (normalized === normalizedName) return true;
    return (TASK_RESOURCE_ALIASES[normalized]?.[resource] ?? []).some((alias) => alias.toLowerCase() === normalizedName);
  });
}

export function isCapabilityAllowed(
  governance: CapabilityGovernance,
  resource: GovernedResource,
  name: string,
): boolean {
  if (governance.denials.some((item) => item.resource === resource && (item.name === '*' || item.name.toLowerCase() === name.toLowerCase()))) return false;
  const grant = governance.grants.find((item) => item.resource === resource && (item.name === '*' || item.name.toLowerCase() === name.toLowerCase()));
  return !!grant;
}
