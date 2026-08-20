import { createChannelAdapter, type ChannelAdapter, type ChannelTransport } from '../channel-adapter.js';
import { CHANNEL_CAPABILITIES } from '../channel-capabilities.js';

export function createWhatsAppAdapter(transport: ChannelTransport): ChannelAdapter {
  return createChannelAdapter({ provider: 'whatsapp', capabilities: CHANNEL_CAPABILITIES.whatsapp, transport });
}
