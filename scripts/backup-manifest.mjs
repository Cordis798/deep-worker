#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANAGED_BACKUP_COMPONENTS = ['config', 'workspaces', 'db'];

export function writeBackupManifest(dataDir) {
  const root = path.resolve(dataDir);
  fs.mkdirSync(root, { recursive: true });
  const presentComponents = MANAGED_BACKUP_COMPONENTS.filter((component) =>
    fs.statSync(path.join(root, component), { throwIfNoEntry: false })?.isDirectory(),
  );
  const manifest = {
    formatVersion: 1,
    managedComponents: MANAGED_BACKUP_COMPONENTS,
    presentComponents,
    excludedTransientComponents: ['ipc', 'logs', 'tmp'],
  };
  fs.writeFileSync(path.join(root, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.argv[2];
  if (!dataDir) {
    console.error('用法：node scripts/backup-manifest.mjs <暂存数据目录>');
    process.exit(2);
  }
  writeBackupManifest(dataDir);
}
