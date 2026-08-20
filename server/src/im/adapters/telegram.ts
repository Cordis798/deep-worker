import { createChannelAdapter, type ChannelAdapter, type ChannelTransport } from '../channel-adapter.js';
import { CHANNEL_CAPABILITIES } from '../channel-capabilities.js';

export function createTelegramAdapter(transport: ChannelTransport): ChannelAdapter {
  return createChannelAdapter({ provider: 'telegram', capabilities: CHANNEL_CAPABILITIES.telegram, transport });
}
