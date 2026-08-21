#!/usr/bin/env node

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { MANAGED_BACKUP_COMPONENTS } from './backup-manifest.mjs';

const TAR_BUFFER_LIMIT = 64 * 1024 * 1024;

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口无效：${raw}`);
  return port;
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(300, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function assertPortFree(port) {
  if (await canConnect('127.0.0.1', port) || await canConnect('::1', port)) throw new Error(`端口 ${port} 仍有服务监听，请先暂停 Runner 和服务后再恢复`);
}

function runTar(args, message) {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: TAR_BUFFER_LIMIT });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${message}：${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout;
}

export function validateArchiveEntries(archivePath) {
  const listing = runTar(['-tzf', archivePath], '读取备份归档失败').split(/\r?\n/).filter(Boolean);
  if (!listing.length) throw new Error('备份归档为空');
  for (const entry of listing) {
    const normalized = entry.replaceAll('\\', '/').replace(/\/$/, '');
    const segments = normalized.split('/');
    if (normalized.startsWith('/') || segments.includes('..') || (normalized !== 'data' && !normalized.startsWith('data/'))) {
      throw new Error(`备份归档包含不安全路径：${entry}`);
    }
  }
}

function validateExtractedTree(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`解压目录包含不安全文件：${candidate}`);
      if (stat.isDirectory()) pending.push(candidate);
    }
  }
}

export function validateRestoredDatabase(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`SQLite 完整性校验失败：${String(result)}`);
  } finally {
    db.close();
  }
}

function readManifest(stagedDataDir) {
  const manifestPath = path.join(stagedDataDir, 'backup-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('备份缺少 manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const managed = [...new Set(manifest.managedComponents ?? [])];
  const present = [...new Set(manifest.presentComponents ?? [])];
  if (manifest.formatVersion !== 1 || managed.length !== MANAGED_BACKUP_COMPONENTS.length || managed.some((item) => !MANAGED_BACKUP_COMPONENTS.includes(item)) || present.some((item) => !managed.includes(item)) || !present.includes('db')) {
    throw new Error('备份 manifest 无效或缺少数据库');
  }
  for (const component of present) {
    if (!fs.statSync(path.join(stagedDataDir, component), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`manifest 记录的目录不存在：${component}`);
  }
  return { managed, present };
}

export function restoreArchive(archivePath, dataDir) {
  const archive = path.resolve(archivePath);
  const destination = path.resolve(dataDir);
  if (!fs.statSync(archive, { throwIfNoEntry: false })?.isFile()) throw new Error(`备份归档不存在：${archive}`);
  validateArchiveEntries(archive);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, '.deep-worker-restore-'));
  const rollback = path.join(stage, 'rollback');
  try {
    runTar(['-xzf', archive, '-C', stage, '--no-same-owner', '--no-same-permissions'], '解压备份失败');
    validateExtractedTree(stage);
    const stagedData = path.join(stage, 'data');
    const manifest = readManifest(stagedData);
    const dbPath = path.join(stagedData, 'db', 'deep-worker.db');
    if (!fs.statSync(dbPath, { throwIfNoEntry: false })?.isFile()) throw new Error('备份缺少 data/db/deep-worker.db');
    validateRestoredDatabase(dbPath);
    fs.mkdirSync(rollback, { recursive: true });
    fs.mkdirSync(destination, { recursive: true });
    const replaced = [];
    try {
      for (const component of manifest.managed) {
        const source = path.join(stagedData, component);
        const target = path.join(destination, component);
        const previous = path.join(rollback, component);
        const hasSource = manifest.present.includes(component);
        const hasTarget = fs.existsSync(target);
        if (hasTarget) fs.renameSync(target, previous);
        if (hasSource) fs.renameSync(source, target);
        replaced.push({ target, previous, hasTarget, installed: hasSource });
      }
    } catch (error) {
      for (const item of replaced.reverse()) {
        if (item.installed) fs.rmSync(item.target, { recursive: true, force: true });
        if (item.hasTarget && fs.existsSync(item.previous)) fs.renameSync(item.previous, item.target);
      }
      throw error;
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'restore' || process.argv.length !== 6) {
    console.error('用法：node scripts/restore-backup.mjs restore <备份归档.tar.gz> <数据目录> <服务端口>');
    process.exit(2);
  }
  await assertPortFree(parsePort(process.argv[5]));
  restoreArchive(process.argv[3], process.argv[4]);
}
