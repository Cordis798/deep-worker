import type { RpcEvent } from './rpc-types.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 从 Pi 的 AgentMessage 或工具结果中提取用户可见文本。 */
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
 * 提取最终助手回复，不把思考过程或工具输出误当成用户答案。
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
