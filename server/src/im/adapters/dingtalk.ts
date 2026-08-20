import { createChannelAdapter, type ChannelAdapter, type ChannelTransport } from '../channel-adapter.js';
import { CHANNEL_CAPABILITIES } from '../channel-capabilities.js';

export function createDingTalkAdapter(transport: ChannelTransport): ChannelAdapter {
  return createChannelAdapter({ provider: 'dingtalk', capabilities: CHANNEL_CAPABILITIES.dingtalk, transport });
}
