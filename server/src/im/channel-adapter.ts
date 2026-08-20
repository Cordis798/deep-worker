import type { ChannelProvider } from '../channel-accounts.js';
import { buildChannelJid, parseChannelJid } from './channel-address.js';
import type { ChannelCapabilities } from './channel-capabilities.js';
import { normalizeProviderInbound } from './channel-provider-rules.js';

export type ChannelConversation = 'private' | 'group';
export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'qr_required' | 'error';

export interface ChannelCredentials {
  [key: string]: unknown;
}

export interface TransportInboundMessage {
  messageId?: string;
  externalChatId: string;
  conversation: ChannelConversation;
  senderId: string;
  senderName?: string;
  text: string;
  threadId?: string;
  rootMessageId?: string;
  timestamp?: string;
}

export interface TransportTarget {
  externalChatId: string;
  threadId?: string;
  rootMessageId?: string;
}

export interface TransportCallbacks {
  onMessage: (message: TransportInboundMessage) => void;
  onDisconnect: (error?: Error) => void;
}

export interface ChannelTransport {
  connect(credentials: ChannelCredentials, callbacks: TransportCallbacks): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(target: TransportTarget, text: string): Promise<void>;
  sendFile(target: TransportTarget, filePath: string, fileName: string): Promise<void>;
  sendImage(target: TransportTarget, data: Uint8Array, mimeType: string, caption?: string, fileName?: string): Promise<void>;
  react(target: TransportTarget, reaction: string): Promise<void>;
  sendStreamingUpdate(target: TransportTarget, text: string, streamId: string, final: boolean): Promise<void>;
}

export interface ChannelInboundMessage extends TransportInboundMessage {
  provider: ChannelProvider;
  accountId: string;
  chatJid: string;
}

export interface ChannelConnectionState {
  status: ChannelStatus;
  error?: string;
}

export interface ChannelAdapter {
  readonly provider: ChannelProvider;
  readonly capabilities: ChannelCapabilities;
  connect(options: { accountId: string; credentials: ChannelCredentials }): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  getStatus(): ChannelConnectionState;
  onMessage(listener: (message: ChannelInboundMessage) => void): () => void;
  sendMessage(chatJid: string, text: string): Promise<void>;
  sendFile(chatJid: string, filePath: string, fileName: string): Promise<void>;
  sendImage(chatJid: string, data: Uint8Array, mimeType: string, caption?: string, fileName?: string): Promise<void>;
  react(chatJid: string, reaction: string): Promise<void>;
  sendStreamingUpdate(chatJid: string, text: string, streamId: string, final: boolean): Promise<void>;
}

export function createChannelAdapter(options: {
  provider: ChannelProvider;
  capabilities: ChannelCapabilities;
  transport: ChannelTransport;
}): ChannelAdapter {
  let accountId: string | undefined;
  let credentials: ChannelCredentials | undefined;
  let state: ChannelConnectionState = { status: 'disconnected' };
  const listeners = new Set<(message: ChannelInboundMessage) => void>();

  const toTarget = (chatJid: string): TransportTarget => {
    const address = parseChannelJid(chatJid);
    if (!address || address.provider !== options.provider) throw new Error('渠道地址与适配器不匹配');
    if (accountId && address.channelAccountId && address.channelAccountId !== accountId) throw new Error('渠道账号与连接不匹配');
    return {
      externalChatId: address.externalChatId,
      ...(address.threadId ? { threadId: address.threadId } : {}),
      ...(address.rootMessageId ? { rootMessageId: address.rootMessageId } : {}),
    };
  };

  const connect = async (reconnecting = false): Promise<void> => {
    if (!accountId || !credentials) throw new Error('连接渠道前必须提供账号和凭据');
    state = { status: reconnecting ? 'reconnecting' : 'connecting' };
    try {
      await options.transport.connect(credentials, {
        onMessage: (message) => {
          const normalizedMessage = normalizeProviderInbound(options.provider, message);
          if (!normalizedMessage) return;
          const jid = buildChannelJid({
            provider: options.provider,
            externalChatId: normalizedMessage.externalChatId,
            channelAccountId: accountId!,
            ...(normalizedMessage.threadId ? { threadId: normalizedMessage.threadId } : {}),
            ...(normalizedMessage.rootMessageId ? { rootMessageId: normalizedMessage.rootMessageId } : {}),
          });
          const normalized: ChannelInboundMessage = {
            ...normalizedMessage,
            provider: options.provider,
            accountId: accountId!,
            chatJid: jid,
          };
          listeners.forEach((listener) => listener(normalized));
        },
        onDisconnect: (error) => {
          state = { status: 'disconnected', ...(error ? { error: error.message } : {}) };
        },
      });
      state = { status: 'connected' };
    } catch (error) {
      state = { status: 'error', error: error instanceof Error ? error.message : '渠道连接失败' };
      throw error;
    }
  };

  return {
    provider: options.provider,
    capabilities: options.capabilities,
    connect: async ({ accountId: nextAccountId, credentials: nextCredentials }) => {
      accountId = nextAccountId;
      credentials = nextCredentials;
      await connect();
    },
    disconnect: async () => {
      await options.transport.disconnect();
      state = { status: 'disconnected' };
    },
    reconnect: async () => {
      await connect(true);
    },
    getStatus: () => ({ ...state }),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendMessage: async (chatJid, text) => options.transport.sendMessage(toTarget(chatJid), text),
    sendFile: async (chatJid, filePath, fileName) => {
      if (!options.capabilities.supportsFileSend) throw new Error('当前渠道不支持文件投递');
      return options.transport.sendFile(toTarget(chatJid), filePath, fileName);
    },
    sendImage: async (chatJid, data, mimeType, caption, fileName) => {
      if (!options.capabilities.supportsImageSend) throw new Error('当前渠道不支持图片投递');
      return options.transport.sendImage(toTarget(chatJid), data, mimeType, caption, fileName);
    },
    react: async (chatJid, reaction) => {
      if (!options.capabilities.supportsReaction) throw new Error('当前渠道不支持 Reaction');
      return options.transport.react(toTarget(chatJid), reaction);
    },
    sendStreamingUpdate: async (chatJid, text, streamId, final) => {
      if (!options.capabilities.supportsStreamingUpdates) throw new Error('当前渠道不支持流式更新');
      return options.transport.sendStreamingUpdate(toTarget(chatJid), text, streamId, final);
    },
  };
}
