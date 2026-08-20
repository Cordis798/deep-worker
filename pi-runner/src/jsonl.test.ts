import { describe, expect, it } from 'vitest';
import { JsonlDecoder, serializeJsonLine } from './jsonl.js';

describe('strict JSONL framing', () => {
  it('splits only on LF and accepts CRLF', () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('{"text":"first"}\r\n{"text":"second"}')).toEqual([
      '{"text":"first"}',
    ]);
    expect(decoder.end()).toEqual(['{"text":"second"}']);
  });

  it('keeps Unicode line separators inside a JSON payload', () => {
    const decoder = new JsonlDecoder();
    const payload = JSON.stringify({ text: 'before\u2028after\u2029end' });
    expect(decoder.push(`${payload}\n`)).toEqual([payload]);
  });

  it('handles UTF-8 bytes split across chunks', () => {
    const decoder = new JsonlDecoder();
    const line = serializeJsonLine({ text: '中文' });
    const bytes = Buffer.from(line);
    expect(decoder.push(bytes.subarray(0, bytes.length - 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(bytes.length - 2))).toEqual([
      line.slice(0, -1),
    ]);
  });
});
