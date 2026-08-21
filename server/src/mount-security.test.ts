import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAdditionalMounts } from './mount-security.js';

describe('容器挂载 allowlist', () => {
  it('只允许规范化后的 allowlist 路径，并区分只读和读写', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-mount-'));
    const allowed = path.join(root, 'allowed');
    const writable = path.join(root, 'writable');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(allowed);
    fs.mkdirSync(writable);
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(writable, 'secret-data'));
    try {
      const policy = { allowedRoots: [{ path: allowed, allowReadWrite: false }, { path: writable, allowReadWrite: true }], blockedPatterns: ['secret'] };
      const readonly = validateAdditionalMounts([{ hostPath: path.join(allowed, '.'), containerPath: '/workspace/extra/docs', readonly: true }], policy);
      expect(readonly[0].hostPath).toBe(fs.realpathSync(allowed));
      expect(() => validateAdditionalMounts([{ hostPath: allowed, containerPath: '/workspace/extra/docs', readonly: false }], policy)).toThrow('只允许只读');
      expect(() => validateAdditionalMounts([{ hostPath: outside, containerPath: '/workspace/extra/docs', readonly: true }], policy)).toThrow('不在 allowlist');
      expect(() => validateAdditionalMounts([{ hostPath: path.join(writable, 'secret-data'), containerPath: '/workspace/extra/docs', readonly: true }], policy)).toThrow('禁止规则');
      expect(() => validateAdditionalMounts([{ hostPath: writable, containerPath: '/workspace/extra/../escape', readonly: true }], policy)).toThrow('目标不安全');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('拒绝通过符号链接逃逸到 allowlist 外部', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-mount-link-'));
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    const link = path.join(allowed, 'link');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    try {
      try {
        fs.symlinkSync(outside, link, 'junction');
      } catch {
        return;
      }
      expect(() => validateAdditionalMounts([{ hostPath: link, containerPath: '/workspace/extra/link', readonly: true }], {
        allowedRoots: [{ path: allowed, allowReadWrite: false }],
        blockedPatterns: [],
      })).toThrow('不在 allowlist');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
