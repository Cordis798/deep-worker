import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ContainerMount } from './container-runner.js';

export interface MountAllowlistRoot {
  path: string;
  allowReadWrite: boolean;
}

export interface MountAllowlist {
  allowedRoots: MountAllowlistRoot[];
  blockedPatterns: string[];
}

function canonical(value: string): string {
  const resolved = path.resolve(value);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })) throw new Error(`挂载源不存在：${value}`);
  return fs.realpathSync(resolved);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function validateAdditionalMounts(
  mounts: readonly ContainerMount[],
  policy: MountAllowlist,
): ContainerMount[] {
  const roots = policy.allowedRoots.map((root) => ({ ...root, path: canonical(root.path) }));
  const blocked = policy.blockedPatterns.map((value) => value.toLowerCase()).filter(Boolean);
  const destinations = new Set<string>();
  return mounts.map((mount) => {
    const hostPath = canonical(mount.hostPath);
    const lower = hostPath.toLowerCase();
    if (blocked.some((pattern) => lower.includes(pattern))) throw new Error(`挂载源命中禁止规则：${mount.hostPath}`);
    const root = roots.find((candidate) => isWithin(candidate.path, hostPath));
    if (!root) throw new Error(`挂载源不在 allowlist 内：${mount.hostPath}`);
    if (mount.readonly !== true && !root.allowReadWrite) throw new Error(`挂载源只允许只读：${mount.hostPath}`);
    const containerPath = path.posix.normalize(mount.containerPath);
    if (!containerPath.startsWith('/workspace/extra/') || containerPath.includes('..') || destinations.has(containerPath)) throw new Error(`额外挂载目标不安全：${mount.containerPath}`);
    destinations.add(containerPath);
    return { hostPath, containerPath, readonly: mount.readonly === true };
  });
}

export function readMountAllowlist(db: Database.Database): MountAllowlist {
  const row = db.prepare('SELECT value FROM config_kv WHERE key = ?').get('container_mount_allowlist') as { value?: string } | undefined;
  if (!row?.value) return { allowedRoots: [], blockedPatterns: [] };
  try {
    const parsed = JSON.parse(row.value) as Partial<MountAllowlist>;
    return {
      allowedRoots: Array.isArray(parsed.allowedRoots)
        ? parsed.allowedRoots.filter((root): root is MountAllowlistRoot => !!root && typeof root.path === 'string' && typeof root.allowReadWrite === 'boolean')
        : [],
      blockedPatterns: Array.isArray(parsed.blockedPatterns) ? parsed.blockedPatterns.filter((value): value is string => typeof value === 'string') : [],
    };
  } catch {
    return { allowedRoots: [], blockedPatterns: ['*invalid-policy*'] };
  }
}

export function writeMountAllowlist(db: Database.Database, policy: MountAllowlist): MountAllowlist {
  const normalized = {
    allowedRoots: policy.allowedRoots.map((root) => ({ path: path.resolve(root.path), allowReadWrite: root.allowReadWrite === true })),
    blockedPatterns: policy.blockedPatterns.map((value) => value.trim()).filter(Boolean),
  };
  db.prepare(
    `INSERT INTO config_kv (key, value, updated_at) VALUES ('container_mount_allowlist', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(normalized));
  return normalized;
}
