import type { TransportInboundMessage } from './channel-adapter.js';

export interface NativeContext {
  contextId: string;
  rootMessageId: string;
  title: string;
}

const TITLE_MAX_LENGTH = 48;

export function summarizeNativeContextTitle(value?: string): string {
  const firstLine = (value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const normalized = (firstLine || '渠道话题').replace(/\s+/g, ' ').trim();
  return normalized.length <= TITLE_MAX_LENGTH ? normalized : `${normalized.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

export function resolveNativeContext(message: Pick<TransportInboundMessage, 'threadId' | 'rootMessageId' | 'messageId' | 'text'>): NativeContext | null {
  const contextId = message.threadId || message.rootMessageId || message.messageId;
  if (!contextId) return null;
  return {
    contextId,
    rootMessageId: message.rootMessageId || contextId,
    title: summarizeNativeContextTitle(message.text),
  };
}
