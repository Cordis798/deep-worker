import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import type Database from 'better-sqlite3';
import { DATA_DIR } from '../config.js';

export type SkillScope = 'system' | 'user' | 'project';
export type SkillSourceType = 'builtin' | 'git' | 'https' | 'zip';

export interface SkillManifest {
  name: string;
  description: string;
  version?: string;
  dependencies: string[];
}

export interface SkillRow {
  id: string;
  owner_user_id: string | null;
  scope: SkillScope;
  project_key: string | null;
  name: string;
  source_type: SkillSourceType;
  source_ref: string;
  version: string;
  content_hash: string;
  install_path: string;
  manifest_json: string;
  dependencies_json: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export class SkillError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SkillError';
  }
}

export type SkillImportSource =
  | { type: 'zip'; ref: string; data: Uint8Array; expectedHash?: string; version?: string }
  | { type: 'https'; ref: string; expectedHash?: string; version?: string }
  | { type: 'git'; ref: string; expectedHash?: string; version?: string };

export interface SkillImportInput {
  ownerUserId: string;
  scope: Exclude<SkillScope, 'system'>;
  projectKey?: string;
  source: SkillImportSource;
}

export interface SkillImportOptions {
  baseDir?: string;
  fetchImpl?: typeof fetch;
  gitClone?: (source: string, destination: string) => Promise<void>;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const IGNORED_ENTRIES = new Set(['.DS_Store', '.cache', '.git', '__pycache__', 'node_modules']);
const MAX_ARCHIVE_SIZE = 32 * 1024 * 1024;

function now(): string {
  return new Date().toISOString();
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function assertSafeSegment(value: string, code: string): void {
  if (!SAFE_NAME.test(value) || value === '.' || value === '..') {
    throw new SkillError(code, `名称不安全：${value}`);
  }
}

function canonicalRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const resolved = path.posix.normalize(normalized);
  if (resolved.startsWith('/') || resolved === '..' || resolved.startsWith('../')) {
    throw new SkillError('SKILL_PATH_INVALID', `Skill 文件路径越界：${value}`);
  }
  return resolved;
}

function scanFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string, relativeRoot: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => !IGNORED_ENTRIES.has(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      throw new SkillError('SKILL_READ_FAILED', `无法读取 Skill 目录：${directory}`);
    }
    for (const entry of entries) {
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      canonicalRelativePath(relative);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SkillError('SKILL_PATH_INVALID', `Skill 不允许包含软链接：${relative}`);
      }
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) result.push(relative);
      else throw new SkillError('SKILL_PATH_INVALID', `Skill 文件类型不受支持：${relative}`);
    }
  };
  visit(root, '');
  return result;
}

export function hashSkillDirectory(root: string): string {
  const hash = crypto.createHash('sha256');
  for (const relative of scanFiles(root)) {
    hash.update(`file\0${relative}\0`);
    hash.update(fs.readFileSync(path.join(root, ...relative.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function parseList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return [...new Set(parsed.map((item) => item.trim()).filter(Boolean))];
      }
    } catch {
      throw new SkillError('SKILL_MANIFEST_INVALID', 'dependencies 必须是字符串数组');
    }
  }
  return [...new Set(trimmed.split(',').map((item) => item.trim()).filter(Boolean))];
}

export function readSkillManifest(root: string): SkillManifest {
  const file = path.join(root, 'SKILL.md');
  if (!fs.existsSync(file)) throw new SkillError('SKILL_MANIFEST_INVALID', 'Skill 缺少根目录 SKILL.md');
  const content = fs.readFileSync(file, 'utf8');
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new SkillError('SKILL_MANIFEST_INVALID', 'SKILL.md 缺少 YAML 清单');
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2].trim().replace(/^['"]|['"]$/g, ''));
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') {
    throw new SkillError('SKILL_MANIFEST_INVALID', 'Skill name 不合法');
  }
  if (!description) throw new SkillError('SKILL_MANIFEST_INVALID', 'Skill description 不能为空');
  const version = fields.get('version') || undefined;
  return { name, description, version, dependencies: parseList(fields.get('dependencies') ?? '') };
}

function zipEntryPath(value: string): string {
  return canonicalRelativePath(value);
}

function extractZip(data: Uint8Array, destination: string): void {
  const archive = Buffer.from(data);
  if (archive.length > MAX_ARCHIVE_SIZE) throw new SkillError('SKILL_IMPORT_FAILED', 'ZIP 文件过大');
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new SkillError('SKILL_IMPORT_FAILED', 'ZIP 文件格式无效');
  const entries = archive.readUInt16LE(eocd + 10);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new SkillError('SKILL_IMPORT_FAILED', 'ZIP 中央目录无效');
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const relative = zipEntryPath(name);
    const isDirectory = name.endsWith('/');
    if (flags & 1 || (externalAttributes & 0xf0000000) === 0xa0000000) {
      throw new SkillError('SKILL_PATH_INVALID', `ZIP 包含不安全条目：${name}`);
    }
    if (compressedSize > MAX_ARCHIVE_SIZE || uncompressedSize > MAX_ARCHIVE_SIZE) {
      throw new SkillError('SKILL_IMPORT_FAILED', 'ZIP 条目过大');
    }
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new SkillError('SKILL_IMPORT_FAILED', 'ZIP 本地目录无效');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(start, start + compressedSize);
    if (start < 0 || start + compressedSize > archive.length) throw new SkillError('SKILL_IMPORT_FAILED', 'ZIP 条目越界');
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (!content) throw new SkillError('SKILL_IMPORT_FAILED', `ZIP 压缩方式不支持：${method}`);
    const target = path.join(destination, ...relative.split('/'));
    const relativeTarget = path.relative(destination, target);
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) throw new SkillError('SKILL_PATH_INVALID', `ZIP 条目越界：${name}`);
    if (isDirectory) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

function findSkillRoot(root: string): string {
  if (fs.existsSync(path.join(root, 'SKILL.md'))) return root;
  const children = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (children.length === 1 && fs.existsSync(path.join(root, children[0].name, 'SKILL.md'))) return path.join(root, children[0].name);
  throw new SkillError('SKILL_MANIFEST_INVALID', '导入内容必须直接包含 SKILL.md，或只包含一个 Skill 目录');
}

async function defaultGitClone(source: string, destination: string): Promise<void> {
  execFileSync('git', ['clone', '--depth', '1', source, destination], { stdio: ['ignore', 'ignore', 'pipe'] });
}

function redactedSourceRef(source: string): string {
  try {
    const url = new URL(source);
    if (url.username || url.password) {
      url.username = 'redacted';
      url.password = 'redacted';
    }
    return url.toString();
  } catch {
    return source;
  }
}

async function materializeSource(source: SkillImportSource, root: string, options: SkillImportOptions): Promise<string> {
  const unpack = path.join(root, 'unpack');
  fs.mkdirSync(unpack, { recursive: true });
  if (source.type === 'zip') {
    extractZip(source.data, unpack);
    return findSkillRoot(unpack);
  }
  if (source.type === 'git') {
    await (options.gitClone ?? defaultGitClone)(source.ref, unpack);
    return findSkillRoot(unpack);
  }
  const response = await (options.fetchImpl ?? fetch)(source.ref);
  if (!response.ok) throw new SkillError('SKILL_IMPORT_FAILED', `HTTPS 下载失败：${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  extractZip(data, unpack);
  return findSkillRoot(unpack);
}

export async function importSkill(db: Database.Database, input: SkillImportInput, options: SkillImportOptions = {}): Promise<SkillRow> {
  if (input.scope === 'project' && !input.projectKey?.trim()) throw new SkillError('SKILL_PROJECT_REQUIRED', '项目 Skill 必须提供 projectKey');
  const baseDir = path.resolve(options.baseDir ?? path.join(DATA_DIR, 'managed-skills'));
  fs.mkdirSync(baseDir, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(baseDir, `.import-${process.pid}-`));
  try {
    const root = await materializeSource(input.source, temporary, options);
    const manifest = readSkillManifest(root);
    const contentHash = hashSkillDirectory(root);
    if (input.source.expectedHash && input.source.expectedHash !== contentHash) {
      throw new SkillError('SKILL_HASH_MISMATCH', 'Skill 内容 hash 不匹配');
    }
    const version = input.source.version ?? manifest.version ?? '0.0.0';
    const ownerSegment = shortHash(input.ownerUserId);
    const scopeDir = input.scope === 'project' ? path.join('projects', shortHash(input.projectKey!)) : path.join('users', ownerSegment);
    const installPath = path.join(baseDir, scopeDir, `${manifest.name}-${contentHash.slice(0, 12)}`);
    fs.mkdirSync(path.dirname(installPath), { recursive: true });
    fs.cpSync(root, installPath, { recursive: true, errorOnExist: true });
    const timestamp = now();
    const id = `skill_${crypto.randomUUID()}`;
    db.prepare(`INSERT INTO skills (id, owner_user_id, scope, project_key, name, source_type, source_ref, version, content_hash, install_path, manifest_json, dependencies_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
      id,
      input.ownerUserId,
      input.scope,
      input.projectKey ?? null,
      manifest.name,
      input.source.type,
      redactedSourceRef(input.source.ref),
      version,
      contentHash,
      installPath,
      JSON.stringify(manifest),
      JSON.stringify(manifest.dependencies),
      timestamp,
      timestamp,
    );
    return getSkillById(db, id)!;
  } catch (error) {
    if (error instanceof SkillError) throw error;
    throw new SkillError('SKILL_IMPORT_FAILED', error instanceof Error ? error.message : String(error));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function getSkillById(db: Database.Database, id: string): SkillRow | undefined {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as (Omit<SkillRow, 'enabled'> & { enabled: number }) | undefined;
  return row ? { ...row, enabled: row.enabled === 1 } : undefined;
}

export function listSkills(db: Database.Database, options: { ownerUserId: string; projectKey?: string }): SkillRow[] {
  const rows = db.prepare(`SELECT * FROM skills WHERE (scope = 'user' AND owner_user_id = ?) OR (scope = 'project' AND owner_user_id = ? AND project_key = ?) ORDER BY name, updated_at DESC`).all(options.ownerUserId, options.ownerUserId, options.projectKey ?? '') as Array<Omit<SkillRow, 'enabled'> & { enabled: number }>;
  return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
}

export function setSkillEnabled(db: Database.Database, ownerUserId: string, id: string, enabled: boolean): boolean {
  return db.prepare('UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?').run(enabled ? 1 : 0, now(), id, ownerUserId).changes === 1;
}

export interface BuiltinSkillEntry {
  name: string;
  version: string;
  contentHash: string;
  path: string;
}

export interface BuiltinManifestRecord {
  name: string;
  version: string;
  contentHash: string;
}

export function getBuiltinSkillsDir(root = path.join(process.cwd(), 'server', 'skills')): string {
  return root;
}

export function buildBuiltinManifest(root = getBuiltinSkillsDir()): BuiltinSkillEntry[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !IGNORED_ENTRIES.has(entry.name))
    .map((entry) => {
      const skillPath = path.join(root, entry.name);
      const manifest = readSkillManifest(skillPath);
      return { name: manifest.name, version: manifest.version ?? '0.0.0', contentHash: hashSkillDirectory(skillPath), path: skillPath };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function verifyBuiltinManifest(root: string, expected: BuiltinSkillEntry[]): boolean {
  try {
    return JSON.stringify(buildBuiltinManifest(root)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

export function readBuiltinManifestFile(root = getBuiltinSkillsDir()): BuiltinManifestRecord[] {
  const file = path.join(root, 'manifest.json');
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new SkillError('SKILL_MANIFEST_INVALID', '内置 Skill 清单格式无效');
  return parsed as BuiltinManifestRecord[];
}

export function verifyBuiltinManifestFile(root = getBuiltinSkillsDir()): boolean {
  try {
    const expected = readBuiltinManifestFile(root);
    const actual = buildBuiltinManifest(root).map(({ name, version, contentHash }) => ({ name, version, contentHash }));
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

export function toPublicSkill(row: SkillRow) {
  return {
    id: row.id,
    scope: row.scope,
    project_key: row.project_key,
    name: row.name,
    source_type: row.source_type,
    source_ref: row.source_ref,
    version: row.version,
    content_hash: row.content_hash,
    dependencies: JSON.parse(row.dependencies_json) as string[],
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
