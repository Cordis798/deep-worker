import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createBackup } from './backup-service.js';
import { initDatabase } from './db/migration.js';

describe('备份与恢复', () => {
  it('在临时数据目录生成一致性归档并恢复', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-backup-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    const dbPath = path.join(source, 'db', 'deep-worker.db');
    fs.mkdirSync(path.join(source, 'config'), { recursive: true });
    fs.mkdirSync(path.join(source, 'workspaces', 'w1'), { recursive: true });
    fs.writeFileSync(path.join(source, 'config', 'settings.json'), '{"safe":true}');
    fs.writeFileSync(path.join(source, 'workspaces', 'w1', 'note.txt'), '备份内容');
    const db = initDatabase(dbPath);
    db.prepare("INSERT INTO config_kv (key, value) VALUES ('backup-test', 'ok')").run();
    db.close();
    const archive = path.join(root, 'backup.tar.gz');
    const listener = net.createServer().listen(0);
    await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
    const port = (listener.address() as net.AddressInfo).port;
    try {
      await createBackup(archive, source, dbPath);
      expect(() => execFileSync(process.execPath, ['scripts/restore-backup.mjs', 'restore', archive, destination, String(port)], { cwd: process.cwd(), stdio: 'pipe' })).toThrow();
      listener.close();
      await new Promise<void>((resolve) => listener.once('close', () => resolve()));
      execFileSync(process.execPath, ['scripts/restore-backup.mjs', 'restore', archive, destination, String(port)], { cwd: process.cwd() });
      expect(fs.readFileSync(path.join(destination, 'config', 'settings.json'), 'utf8')).toContain('safe');
      expect(fs.readFileSync(path.join(destination, 'workspaces', 'w1', 'note.txt'), 'utf8')).toBe('备份内容');
      const restored = new Database(path.join(destination, 'db', 'deep-worker.db'), { readonly: true });
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      expect((restored.prepare("SELECT value FROM config_kv WHERE key = 'backup-test'").get() as { value: string }).value).toBe('ok');
      restored.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('损坏归档或数据库时恢复失败', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-backup-invalid-'));
    const badArchive = path.join(root, 'bad.tar.gz');
    const destination = path.join(root, 'destination');
    fs.writeFileSync(badArchive, 'not a tar archive');
    try {
      expect(() => execFileSync(process.execPath, ['scripts/restore-backup.mjs', 'restore', badArchive, destination, '65535'], { cwd: process.cwd(), stdio: 'pipe' })).toThrow();
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
