import type { ChannelProvider } from '../channel-accounts.js';

export type { ChannelProvider } from '../channel-accounts.js';

export interface ChannelCapabilities {
  label: string;
  supportsGroup: boolean;
  supportsPrivate: boolean;
  supportsThreadMap: boolean;
  supportsStreamingUpdates: boolean;
  supportsFileSend: boolean;
  supportsImageSend: boolean;
  supportsReaction: boolean;
  requiresQrLogin: boolean;
}

export const CHANNEL_CAPABILITIES: Record<ChannelProvider, ChannelCapabilities> = {
  telegram: {
    label: 'Telegram',
    supportsGroup: true,
    supportsPrivate: true,
    supportsThreadMap: true,
    supportsStreamingUpdates: false,
    supportsFileSend: true,
    supportsImageSend: true,
    supportsReaction: true,
    requiresQrLogin: false,
  },
  discord: {
    label: 'Discord',
    supportsGroup: true,
    supportsPrivate: true,
    supportsThreadMap: false,
    supportsStreamingUpdates: true,
    supportsFileSend: true,
    supportsImageSend: true,
    supportsReaction: true,
    requiresQrLogin: false,
  },
  whatsapp: {
    label: 'WhatsApp',
    supportsGroup: true,
    supportsPrivate: true,
    supportsThreadMap: false,
    supportsStreamingUpdates: false,
    supportsFileSend: true,
    supportsImageSend: true,
    supportsReaction: true,
    requiresQrLogin: true,
  },
  feishu: {
    label: '飞书',
    supportsGroup: true,
    supportsPrivate: true,
    supportsThreadMap: true,
    supportsStreamingUpdates: true,
    supportsFileSend: true,
    supportsImageSend: true,
    supportsReaction: true,
    requiresQrLogin: false,
  },
  qq: {
    label: 'QQ',
    supportsGroup: true,
    supportsPrivate: true,
    supportsThreadMap: false,
    supportsStreamingUpdates: true,
    supportsFileSend: true,
    supportsImageSend: true,
    supportsReaction: true,
    requiresQrLogin: false,
  },
  dingtalk: {
    label: '钉钉',
    supportsGroup: true,
    supportsPrivate: true,
    supportsThreadMap: false,
    supportsStreamingUpdates: true,
    supportsFileSend: true,
    supportsImageSend: true,
    supportsReaction: true,
    requiresQrLogin: false,
  },
  wechat: {
    label: '微信',
    supportsGroup: false,
    supportsPrivate: true,
    supportsThreadMap: false,
    supportsStreamingUpdates: false,
    supportsFileSend: false,
    supportsImageSend: false,
    supportsReaction: false,
    requiresQrLogin: true,
  },
};
