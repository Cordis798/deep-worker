import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { DB_PATH, DATA_DIR } from './config.js';

const COMPONENTS = ['config', 'workspaces'];

export async function createBackup(outputArchive: string, dataDir = DATA_DIR, dbPath = DB_PATH): Promise<string> {
  const output = path.resolve(outputArchive);
  const source = path.resolve(dataDir);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-worker-backup-'));
  const stagedData = path.join(stage, 'data');
  try {
    fs.mkdirSync(path.join(stagedData, 'db'), { recursive: true });
    for (const component of COMPONENTS) {
      const sourcePath = path.join(source, component);
      if (fs.existsSync(sourcePath)) fs.cpSync(sourcePath, path.join(stagedData, component), { recursive: true, errorOnExist: false });
    }
    const snapshotPath = path.join(stagedData, 'db', 'deep-worker.db');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      try { await db.backup(snapshotPath); } finally { db.close(); }
    } else {
      new Database(snapshotPath).close();
    }
    const manifestScript = path.join(process.cwd(), 'scripts', 'backup-manifest.mjs');
    const manifest = spawnSync(process.execPath, [manifestScript, stagedData], { encoding: 'utf8' });
    if (manifest.status !== 0) throw new Error(`生成备份 manifest 失败：${manifest.stderr || manifest.stdout}`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const archive = spawnSync('tar', ['-czf', output, '-C', stage, 'data'], { encoding: 'utf8' });
    if (archive.status !== 0) throw new Error(`创建备份归档失败：${archive.stderr || archive.stdout}`);
    return output;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
