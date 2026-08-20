import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db/migration.js';
import {
  SkillError,
  buildBuiltinManifest,
  importSkill,
  listSkills,
  setSkillEnabled,
  verifyBuiltinManifest,
  verifyBuiltinManifestFile,
} from './skill-store.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-skills-'));
  temporaryRoots.push(root);
  return root;
}

function zipStoredFile(name: string, content: string): Uint8Array {
  const nameBuffer = Buffer.from(name, 'utf8');
  const contentBuffer = Buffer.from(content, 'utf8');
  const local = Buffer.alloc(30 + nameBuffer.length + contentBuffer.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(contentBuffer.length, 18);
  local.writeUInt32LE(contentBuffer.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuffer.copy(local, 30);
  contentBuffer.copy(local, 30 + nameBuffer.length);

  const central = Buffer.alloc(46 + nameBuffer.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(contentBuffer.length, 20);
  central.writeUInt32LE(contentBuffer.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  nameBuffer.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

describe('Skill 存储与导入', () => {
  it('导入 ZIP 后隔离保存来源、版本和 hash，并支持禁用', async () => {
    const root = createRoot();
    const db = initDatabase(':memory:');
    db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run('user-1', 'skill-user', 'hash', new Date().toISOString(), new Date().toISOString());
    const skill = await importSkill(
      db,
      {
        ownerUserId: 'user-1',
        scope: 'user',
        source: { type: 'zip', ref: 'upload.zip', data: zipStoredFile('SKILL.md', '---\nname: greet\ndescription: greeting\nversion: 1.2.0\n---\nSay hello.') },
      },
      { baseDir: root },
    );

    expect(skill.name).toBe('greet');
    expect(skill.version).toBe('1.2.0');
    expect(skill.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(skill.install_path.startsWith(root)).toBe(true);
    expect(fs.existsSync(path.join(skill.install_path, 'SKILL.md'))).toBe(true);
    expect(listSkills(db, { ownerUserId: 'user-1' })).toHaveLength(1);

    expect(setSkillEnabled(db, 'user-1', skill.id, false)).toBe(true);
    expect(listSkills(db, { ownerUserId: 'user-1' })[0].enabled).toBe(false);
    db.close();
  });

  it('拒绝缺少清单、越界路径和 hash 不匹配的导入', async () => {
    const db = initDatabase(':memory:');
    const root = createRoot();
    db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run('user-1', 'skill-user', 'hash', new Date().toISOString(), new Date().toISOString());
    await expect(importSkill(db, { ownerUserId: 'user-1', scope: 'user', source: { type: 'zip', ref: 'bad.zip', data: zipStoredFile('../SKILL.md', 'bad') } }, { baseDir: root })).rejects.toMatchObject({ code: 'SKILL_PATH_INVALID' });
    await expect(importSkill(db, { ownerUserId: 'user-1', scope: 'user', source: { type: 'zip', ref: 'bad.zip', data: zipStoredFile('README.md', 'missing') } }, { baseDir: root })).rejects.toMatchObject({ code: 'SKILL_MANIFEST_INVALID' });
    await expect(importSkill(db, { ownerUserId: 'user-1', scope: 'user', source: { type: 'zip', ref: 'bad.zip', expectedHash: '0'.repeat(64), data: zipStoredFile('SKILL.md', '---\nname: greet\ndescription: greeting\n---') } }, { baseDir: root })).rejects.toMatchObject({ code: 'SKILL_HASH_MISMATCH' });
    db.close();
  });

  it('验证内置清单的内容 hash', () => {
    const root = createRoot();
    const skillDir = path.join(root, 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: test\n---\n');
    const manifest = buildBuiltinManifest(root);
    expect(verifyBuiltinManifest(root, manifest)).toBe(true);
    fs.appendFileSync(path.join(skillDir, 'SKILL.md'), 'changed');
    expect(verifyBuiltinManifest(root, manifest)).toBe(false);
  });

  it('验证提交的内置 manifest 文件', () => {
    const root = createRoot();
    const skillDir = path.join(root, 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: test\nversion: 1.0.0\n---\n');
    const generated = JSON.parse(JSON.stringify([{ name: 'demo', version: '1.0.0', contentHash: 'placeholder' }]));
    generated[0].contentHash = buildBuiltinManifest(root)[0].contentHash;
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(generated));
    expect(verifyBuiltinManifestFile(root)).toBe(true);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify([{ ...generated[0], contentHash: '0'.repeat(64) }]));
    expect(verifyBuiltinManifestFile(root)).toBe(false);
  });
});
