import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_BYTES = 512 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yml',
  '.yaml', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx',
]);

export interface FileTextResult {
  text: string;
  truncated: boolean;
  method: 'text';
}

export class FileTextError extends Error {
  constructor(public readonly code: 'unsupported' | 'too_large' | 'unreadable', message: string) {
    super(message);
    this.name = 'FileTextError';
  }
}

function truncateUtf8(text: string): FileTextResult {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= MAX_EXTRACTED_TEXT_BYTES) return { text, truncated: false, method: 'text' };
  let end = MAX_EXTRACTED_TEXT_BYTES;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return {
    text: `${buffer.subarray(0, end).toString('utf8')}\n\n[内容过长，已截断；完整文件请下载查看]`,
    truncated: true,
    method: 'text',
  };
}

export async function extractFileText(filePath: string): Promise<FileTextResult> {
  const extension = path.extname(filePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) throw new FileTextError('unsupported', '该文件类型不支持文本提取');
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new FileTextError('unreadable', '文件不存在或无法读取');
  }
  if (!stat.isFile()) throw new FileTextError('unreadable', '目标不是文件');
  if (stat.size > MAX_TEXT_FILE_BYTES) throw new FileTextError('too_large', '文本文件超过 5MB 限制');
  try {
    return truncateUtf8(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new FileTextError('unreadable', '文件内容无法按文本读取');
  }
}
