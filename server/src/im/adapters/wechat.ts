import { createChannelAdapter, type ChannelAdapter, type ChannelTransport } from '../channel-adapter.js';
import { CHANNEL_CAPABILITIES } from '../channel-capabilities.js';

export function createWeChatAdapter(transport: ChannelTransport): ChannelAdapter {
  return createChannelAdapter({ provider: 'wechat', capabilities: CHANNEL_CAPABILITIES.wechat, transport });
}
