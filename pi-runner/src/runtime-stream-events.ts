import type { StreamEvent } from '@deep-worker/shared';
import { extractTextContent } from './output-parser.js';
import type { RuntimeEvent } from './runtime.js';

export interface RuntimeStreamEventContext {
  sessionId: string;
  turnId?: string;
  queryRunId?: string;
}

function common(
  event: RuntimeEvent,
  context: RuntimeStreamEventContext,
): Pick<StreamEvent, 'sessionId' | 'turnId' | 'queryRunId' | 'rawType' | 'rawEvent'> {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    queryRunId: context.queryRunId,
    rawType: `runtime:${event.type}`,
    rawEvent: event,
  };
}

export function mapRuntimeEvent(
  event: RuntimeEvent,
  context: RuntimeStreamEventContext,
): StreamEvent[] {
  const base = common(event, context);
  if (event.type === 'text_delta' || event.type === 'thinking_delta') {
    return [
      {
        ...base,
        eventType: event.type,
        text: event.delta,
        isSynthetic: true,
      },
    ];
  }
  if (event.type === 'tool_start') {
    return [
      {
        ...base,
        eventType: 'tool_use_start',
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        toolInput:
          event.input && typeof event.input === 'object'
            ? (event.input as Record<string, unknown>)
            : undefined,
        isSynthetic: true,
      },
    ];
  }
  if (event.type === 'tool_update') {
    return [
      {
        ...base,
        eventType: 'tool_progress',
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        toolResult: extractTextContent(event.result),
        isSynthetic: true,
      },
    ];
  }
  if (event.type === 'tool_end') {
    return [
      {
        ...base,
        eventType: 'tool_result',
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        toolResult: extractTextContent(event.result),
        statusText: event.isError ? 'tool failed' : 'tool completed',
        isSynthetic: true,
      },
    ];
  }
  if (event.type === 'status') {
    return [
      {
        ...base,
        eventType: 'status',
        statusText: event.statusText,
        isSynthetic: true,
      },
    ];
  }
  if (event.type !== 'result') return [];
  if (event.result.usage) {
    return [
      {
        ...base,
        eventType: 'usage',
        usage: {
          inputTokens: event.result.usage.inputTokens,
          outputTokens: event.result.usage.outputTokens,
          cacheReadInputTokens: event.result.usage.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens:
            event.result.usage.cacheCreationInputTokens ?? 0,
          costUSD: event.result.usage.costUSD,
        },
        isSynthetic: true,
      },
    ];
  }
  return [];
}
