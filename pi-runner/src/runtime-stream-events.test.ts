import { describe, expect, it } from 'vitest';
import { mapRuntimeEvent } from './runtime-stream-events.js';

const context = { sessionId: 'app-session', turnId: 'turn-1', queryRunId: 'run-1' };

describe('mapRuntimeEvent', () => {
  it('maps SDK deltas and tool lifecycle to the shared stream contract', () => {
    expect(
      mapRuntimeEvent(
        { type: 'text_delta', sessionId: 'sdk-session', delta: 'hello' },
        context,
      ),
    ).toEqual([
      expect.objectContaining({
        eventType: 'text_delta',
        sessionId: 'app-session',
        turnId: 'turn-1',
        text: 'hello',
      }),
    ]);
    expect(
      mapRuntimeEvent(
        {
          type: 'tool_end',
          sessionId: 'sdk-session',
          toolName: 'bash',
          toolCallId: 'tool-1',
          result: { content: [{ type: 'text', text: 'done' }] },
        },
        context,
      )[0],
    ).toMatchObject({
      eventType: 'tool_result',
      toolName: 'bash',
      toolUseId: 'tool-1',
      toolResult: 'done',
    });
  });

  it('emits usage exactly from the terminal SDK result', () => {
    expect(
      mapRuntimeEvent(
        {
          type: 'result',
          sessionId: 'sdk-session',
          result: {
            text: 'done',
            sessionId: 'sdk-session',
            finalizationReason: 'completed',
            usage: {
              inputTokens: 10,
              outputTokens: 3,
              cacheReadInputTokens: 2,
              cacheCreationInputTokens: 1,
              costUSD: 0.02,
            },
          },
        },
        context,
      ),
    ).toEqual([
      expect.objectContaining({
        eventType: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 3,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
          costUSD: 0.02,
        },
      }),
    ]);
  });
});
