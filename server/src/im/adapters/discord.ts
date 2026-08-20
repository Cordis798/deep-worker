import { createChannelAdapter, type ChannelAdapter, type ChannelTransport } from '../channel-adapter.js';
import { CHANNEL_CAPABILITIES } from '../channel-capabilities.js';

export function createDiscordAdapter(transport: ChannelTransport): ChannelAdapter {
  return createChannelAdapter({ provider: 'discord', capabilities: CHANNEL_CAPABILITIES.discord, transport });
}
