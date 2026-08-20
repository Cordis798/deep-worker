import type { ChannelProvider } from '../channel-accounts.js';
import type { ChannelAdapter, ChannelTransport } from './channel-adapter.js';
import { CHANNEL_CAPABILITIES, type ChannelCapabilities } from './channel-capabilities.js';
import { createDiscordAdapter } from './adapters/discord.js';
import { createDingTalkAdapter } from './adapters/dingtalk.js';
import { createFeishuAdapter } from './adapters/feishu.js';
import { createQqAdapter } from './adapters/qq.js';
import { createTelegramAdapter } from './adapters/telegram.js';
import { createWhatsAppAdapter } from './adapters/whatsapp.js';
import { createWeChatAdapter } from './adapters/wechat.js';

type AdapterFactory = (transport: ChannelTransport) => ChannelAdapter;

const DEFAULT_FACTORIES: Record<ChannelProvider, AdapterFactory> = {
  telegram: createTelegramAdapter,
  discord: createDiscordAdapter,
  whatsapp: createWhatsAppAdapter,
  feishu: createFeishuAdapter,
  qq: createQqAdapter,
  dingtalk: createDingTalkAdapter,
  wechat: createWeChatAdapter,
};

export class ChannelAdapterRegistry {
  constructor(private readonly factories: Record<ChannelProvider, AdapterFactory> = DEFAULT_FACTORIES) {}

  create(provider: ChannelProvider, transport: ChannelTransport): ChannelAdapter {
    return this.factories[provider](transport);
  }

  getCapabilities(provider: ChannelProvider): ChannelCapabilities {
    return CHANNEL_CAPABILITIES[provider];
  }

  listProviders(): ChannelProvider[] {
    return Object.keys(this.factories) as ChannelProvider[];
  }
}

export function createDefaultChannelAdapterRegistry(): ChannelAdapterRegistry {
  return new ChannelAdapterRegistry();
}
