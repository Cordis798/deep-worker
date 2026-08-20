import { describe, expect, it } from 'vitest';
import { mapPiEvent } from './stream-events.js';

const context = { sessionId: 's1', turnId: 't1', queryRunId: 'q1' };

describe('Pi event mapping', () => {
  it('maps text and thinking deltas with local correlation fields', () => {
    expect(
      mapPiEvent(
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
        },
        context,
      ),
    ).toEqual([
      expect.objectContaining({
        eventType: 'text_delta',
        text: 'hello',
        sessionId: 's1',
        turnId: 't1',
        isSynthetic: true,
      }),
    ]);
    expect(
      mapPiEvent(
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'reason' },
        },
        context,
      )[0],
    ).toMatchObject({ eventType: 'thinking_delta', text: 'reason' });
  });

  it('maps tool lifecycle, progress, result and usage', () => {
    expect(
      mapPiEvent(
        {
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'bash',
          args: { command: 'echo hi' },
        },
        context,
      )[0],
    ).toMatchObject({
      eventType: 'tool_use_start',
      toolUseId: 'call-1',
      toolName: 'bash',
      toolInput: { command: 'echo hi' },
    });
    expect(
      mapPiEvent(
        {
          type: 'tool_execution_update',
          toolCallId: 'call-1',
          toolName: 'bash',
          partialResult: { content: [{ type: 'text', text: 'hi' }] },
        },
        context,
      )[0],
    ).toMatchObject({ eventType: 'tool_progress', toolResult: 'hi' });
    expect(
      mapPiEvent(
        {
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'done' }] },
          isError: false,
        },
        context,
      )[0],
    ).toMatchObject({ eventType: 'tool_result', toolResult: 'done' });
    expect(
      mapPiEvent(
        {
          type: 'message_update',
          usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
          assistantMessageEvent: { type: 'text_delta', delta: 'x' },
        },
        context,
      ),
    ).toEqual([
      expect.objectContaining({ eventType: 'text_delta' }),
      expect.objectContaining({
        eventType: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
        },
      }),
    ]);
  });

  it('preserves unknown events as raw SDK events', () => {
    expect(mapPiEvent({ type: 'extension_error', error: 'x' }, context)[0]).toMatchObject({
      eventType: 'raw_sdk_event',
      rawType: 'extension_error',
      rawEvent: { type: 'extension_error', error: 'x' },
    });
  });
});
