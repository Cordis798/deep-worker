import type { StreamEvent, StreamUsage } from '@deep-worker/shared';
import type { RpcEvent } from './rpc-types.js';
import { extractTextContent } from './output-parser.js';

export interface StreamEventContext {
  sessionId: string;
  turnId?: string;
  queryRunId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function base(
  event: RpcEvent,
  context: StreamEventContext,
): Pick<StreamEvent, 'sessionId' | 'turnId' | 'queryRunId' | 'rawType' | 'rawEvent'> {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    queryRunId: context.queryRunId,
    rawType: event.type,
    rawEvent: event,
  };
}

function usage(value: unknown): StreamUsage | undefined {
  const source = record(value);
  if (!source) return undefined;
  const inputTokens = number(source.input) ?? number(source.inputTokens);
  const outputTokens = number(source.output) ?? number(source.outputTokens);
  const cacheRead = number(source.cacheRead) ?? number(source.cacheReadInputTokens);
  const cacheWrite = number(source.cacheWrite) ?? number(source.cacheCreationInputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead ?? 0,
    cacheCreationInputTokens: cacheWrite ?? 0,
    costUSD: number(record(source.cost)?.total) ?? number(source.costUSD),
  };
}

function withBase(
  event: RpcEvent,
  context: StreamEventContext,
  value: Omit<StreamEvent, 'sessionId' | 'turnId' | 'queryRunId' | 'rawType' | 'rawEvent'>,
): StreamEvent {
  return { ...base(event, context), ...value, isSynthetic: true };
}

/** 只把 Pi RPC 证据已确认的字段映射到共享流事件结构。 */
export function mapPiEvent(event: RpcEvent, context: StreamEventContext): StreamEvent[] {
  const mapped: StreamEvent[] = [];
  const common = base(event, context);
  if (event.type === 'message_update') {
    const delta = record(event.assistantMessageEvent);
    const deltaType = text(delta?.type);
    if (deltaType === 'text_delta') {
      mapped.push(
        withBase(event, context, { eventType: 'text_delta', text: text(delta?.delta) ?? '' }),
      );
    } else if (deltaType === 'thinking_delta') {
      mapped.push(
        withBase(event, context, {
          eventType: 'thinking_delta',
          text: text(delta?.delta) ?? '',
        }),
      );
    } else if (deltaType === 'toolcall_start') {
      const args = record(delta?.args);
      mapped.push(
        withBase(event, context, {
          eventType: 'tool_use_start',
          toolUseId: text(delta?.id),
          toolName: text(delta?.toolName),
          toolInput: args ?? undefined,
        }),
      );
    } else if (deltaType === 'toolcall_delta') {
      mapped.push(
        withBase(event, context, {
          eventType: 'tool_progress',
          toolUseId: text(delta?.id),
          detail: text(delta?.delta),
        }),
      );
    } else if (deltaType === 'toolcall_end') {
      const call = record(delta?.toolCall);
      mapped.push(
        withBase(event, context, {
          eventType: 'tool_use_end',
          toolUseId: text(call?.id) ?? text(delta?.id),
          toolName: text(call?.name) ?? text(call?.toolName),
          toolInput: record(call?.arguments) ?? record(call?.args) ?? undefined,
        }),
      );
    }
    const eventUsage = usage(event.usage);
    if (eventUsage)
      mapped.push(withBase(event, context, { eventType: 'usage', usage: eventUsage }));
    if (mapped.length > 0) return mapped;
  } else if (event.type === 'tool_execution_start') {
    mapped.push(
      withBase(event, context, {
        eventType: 'tool_use_start',
        toolUseId: text(event.toolCallId),
        toolName: text(event.toolName),
        toolInput: record(event.args) ?? undefined,
      }),
    );
    return mapped;
  } else if (event.type === 'tool_execution_update') {
    mapped.push(
      withBase(event, context, {
        eventType: 'tool_progress',
        toolUseId: text(event.toolCallId),
        toolName: text(event.toolName),
        toolResult: extractTextContent(event.partialResult),
      }),
    );
    return mapped;
  } else if (event.type === 'tool_execution_end') {
    mapped.push(
      withBase(event, context, {
        eventType: 'tool_result',
        toolUseId: text(event.toolCallId),
        toolName: text(event.toolName),
        toolResult: extractTextContent(event.result),
        statusText: event.isError === true ? 'tool failed' : 'tool completed',
      }),
    );
    return mapped;
  } else if (event.type === 'bash_execution_update') {
    mapped.push(
      withBase(event, context, {
        eventType: 'tool_progress',
        toolName: 'bash',
        toolUseId: text(event.id),
        detail: text(event.delta),
      }),
    );
    return mapped;
  } else if (event.type === 'agent_start') {
    mapped.push(withBase(event, context, { eventType: 'init', statusText: 'agent started' }));
    return mapped;
  } else if (event.type === 'agent_settled') {
    mapped.push(withBase(event, context, { eventType: 'status', statusText: 'agent settled' }));
    return mapped;
  } else if (event.type === 'turn_start' || event.type === 'turn_end') {
    mapped.push(withBase(event, context, { eventType: 'status', statusText: event.type }));
    return mapped;
  }
  return [{ ...common, eventType: 'raw_sdk_event', isSynthetic: false }];
}
