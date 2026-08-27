import { describe, expect, it } from 'vitest';
import { resultFromAssistantMessage, textFromRuntimeMessage } from './runtime.js';

describe('runtime result extraction', () => {
  it('joins assistant text blocks and preserves usage', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
      stopReason: 'stop',
      usage: {
        input: 12,
        output: 4,
        cacheRead: 3,
        cacheWrite: 2,
        cost: { total: 0.01 },
      },
    };

    expect(textFromRuntimeMessage(message)).toBe('hello world');
    expect(resultFromAssistantMessage(message, 'session-1')).toEqual({
      text: 'hello world',
      sessionId: 'session-1',
      finalizationReason: 'completed',
      stopReason: 'stop',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        costUSD: 0.01,
      },
    });
  });

  it('marks aborted and failed replies without throwing away the error', () => {
    expect(
      resultFromAssistantMessage(
        { role: 'assistant', content: [], stopReason: 'aborted' },
        'session-2',
      ).finalizationReason,
    ).toBe('interrupted');
    expect(
      resultFromAssistantMessage(
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
          stopReason: 'error',
          errorMessage: 'provider failed',
        },
        'session-3',
      ),
    ).toMatchObject({
      text: 'partial',
      finalizationReason: 'error',
      error: 'provider failed',
    });
  });
});
