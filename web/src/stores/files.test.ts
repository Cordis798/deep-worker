import { describe, expect, it } from 'vitest';
import { encodeFilePath } from './files.js';

describe('文件路径编码', () => {
  it('支持中文和目录分隔符，并生成 URL 安全字符串', () => {
    const encoded = encodeFilePath('docs/说明 1.txt');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('=');
    expect(encoded).toBe('ZG9jcy_or7TmmI4gMS50eHQ');
  });
});
