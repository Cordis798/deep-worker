import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractFileText, FileTextError, MAX_EXTRACTED_TEXT_BYTES } from './file-text-extractor.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('文件文本提取', () => {
  it('读取常见文本并在输出过大时截断', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-text-'));
    roots.push(root);
    const file = path.join(root, 'note.md');
    await fs.writeFile(file, 'a'.repeat(MAX_EXTRACTED_TEXT_BYTES + 100), 'utf8');
    const result = await extractFileText(file);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('内容过长');
  });

  it('拒绝不支持的二进制扩展名', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-text-'));
    roots.push(root);
    const file = path.join(root, 'archive.bin');
    await fs.writeFile(file, Buffer.from([0, 1, 2, 3]));
    await expect(extractFileText(file)).rejects.toMatchObject({ code: 'unsupported' } satisfies Partial<FileTextError>);
  });
});
