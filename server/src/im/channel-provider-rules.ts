import type { ChannelProvider } from '../channel-accounts.js';
import type { TransportInboundMessage } from './channel-adapter.js';

export function normalizeProviderInbound(provider: ChannelProvider, message: TransportInboundMessage): TransportInboundMessage | null {
  if (provider === 'wechat' && message.conversation === 'group') return null;
  const inferred = inferConversation(provider, message.externalChatId);
  return inferred ? { ...message, conversation: inferred } : message;
}

export function inferConversation(provider: ChannelProvider, externalChatId: string): 'private' | 'group' | null {
  if (provider === 'telegram') {
    if (/^-\d+$/.test(externalChatId)) return 'group';
    if (/^\d+$/.test(externalChatId)) return 'private';
  }
  if (provider === 'discord') {
    if (externalChatId.startsWith('dm:')) return 'private';
  }
  if (provider === 'whatsapp') {
    if (externalChatId.endsWith('@g.us')) return 'group';
    if (externalChatId.endsWith('@s.whatsapp.net')) return 'private';
  }
  if (provider === 'qq') {
    if (externalChatId.startsWith('c2c:')) return 'private';
    if (externalChatId.startsWith('group:')) return 'group';
  }
  if (provider === 'dingtalk') {
    if (externalChatId.startsWith('c2c:')) return 'private';
    if (externalChatId.startsWith('conversation:')) return 'group';
  }
  return null;
}
