import { createChannelAdapter, type ChannelAdapter, type ChannelTransport } from '../channel-adapter.js';
import { CHANNEL_CAPABILITIES } from '../channel-capabilities.js';

export function createFeishuAdapter(transport: ChannelTransport): ChannelAdapter {
  return createChannelAdapter({ provider: 'feishu', capabilities: CHANNEL_CAPABILITIES.feishu, transport });
}
