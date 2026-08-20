import { describe, expect, it } from 'vitest';
import { extractFinalReply, extractTextContent } from './output-parser.js';

describe('Pi output parser', () => {
  it('extracts text from Pi content blocks', () => {
    expect(
      extractTextContent({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'hello' },
          { type: 'text', text: ' world' },
        ],
      }),
    ).toBe('hello world');
  });

  it('prefers streamed text and falls back to message_end', () => {
    expect(
      extractFinalReply([
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } },
        { type: 'message_end', message: { content: [{ type: 'text', text: 'ignored' }] } },
      ]),
    ).toBe('ab');
    expect(
      extractFinalReply([{ type: 'message_end', message: { content: [{ type: 'text', text: 'fallback' }] } }]),
    ).toBe('fallback');
  });
});
