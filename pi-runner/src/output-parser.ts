import type { RpcEvent } from './rpc-types.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extract user-visible text from a Pi AgentMessage or tool result. */
export function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractTextContent).join('');
  const record = asRecord(value);
  if (!record) return '';
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) return extractTextContent(record.content);
  return '';
}

/**
 * Extract the final assistant reply without treating thinking or tool output
 * as a user-facing answer.
 */
export function extractFinalReply(events: readonly RpcEvent[]): string {
  let streamed = '';
  let messageEndFallback = '';
  for (const event of events) {
    if (event.type === 'message_update') {
      const delta = asRecord(event.assistantMessageEvent);
      if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
        streamed += delta.delta;
      }
    } else if (event.type === 'message_end') {
      messageEndFallback = extractTextContent(event.message);
    }
  }
  return streamed || messageEndFallback;
}
