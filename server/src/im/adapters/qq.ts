import { createChannelAdapter, type ChannelAdapter, type ChannelTransport } from '../channel-adapter.js';
import { CHANNEL_CAPABILITIES } from '../channel-capabilities.js';

export function createQqAdapter(transport: ChannelTransport): ChannelAdapter {
  return createChannelAdapter({ provider: 'qq', capabilities: CHANNEL_CAPABILITIES.qq, transport });
}
