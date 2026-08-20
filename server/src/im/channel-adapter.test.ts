import { describe, expect, it } from 'vitest';
import { FakeTransport } from './fake-transport.js';
import { createChannelAdapter } from './channel-adapter.js';
import { CHANNEL_CAPABILITIES, type ChannelProvider } from './channel-capabilities.js';

const providers: ChannelProvider[] = [
  'telegram',
  'discord',
  'whatsapp',
  'feishu',
  'qq',
  'dingtalk',
  'wechat',
];

describe('统一渠道适配器', () => {
  it.each(providers)('%s 能完成入站、投递和断线重连', async (provider) => {
    const transport = new FakeTransport();
    const adapter = createChannelAdapter({
      provider,
      capabilities: CHANNEL_CAPABILITIES[provider],
      transport,
    });
    const received: Array<{ chatJid: string; text: string }> = [];
    adapter.onMessage((message) => received.push({ chatJid: message.chatJid, text: message.text }));

    await adapter.connect({ accountId: 'ca_test', credentials: { token: 'hidden-in-test' } });
    transport.emitMessage({
      externalChatId: 'chat/1',
      conversation: provider === 'wechat' ? 'private' : 'group',
      senderId: 'user/1',
      senderName: '测试用户',
      text: '你好',
      threadId: provider === 'feishu' ? 'topic/1' : undefined,
      rootMessageId: provider === 'feishu' ? 'root/1' : undefined,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.chatJid).toContain(`${provider}:`);
    expect(received[0]?.chatJid).toContain('#account:ca_test');
    expect(received[0]?.text).toBe('你好');

    const target = received[0]!.chatJid;
    await adapter.sendMessage(target, '回复');
    await adapter.sendFile(target, 'report.txt', '报告');
    await adapter.sendImage(target, new Uint8Array([1, 2]), 'image/png', '截图');
    await adapter.react(target, '👍');
    expect(transport.sent.map((item) => item.kind)).toEqual(['message', 'file', 'image', 'reaction']);

    transport.dropConnection(new Error('网络断开'));
    expect(adapter.getStatus().status).toBe('disconnected');
    await adapter.reconnect();
    expect(adapter.getStatus().status).toBe('connected');
    expect(transport.connectCount).toBe(2);
  });

  it('飞书适配器支持最小流式更新，非流式渠道明确拒绝', async () => {
    const feishuTransport = new FakeTransport();
    const feishu = createChannelAdapter({ provider: 'feishu', capabilities: CHANNEL_CAPABILITIES.feishu, transport: feishuTransport });
    await feishu.connect({ accountId: 'ca_feishu', credentials: {} });
    const target = 'feishu:oc_group#account:ca_feishu#thread:topic#root:root';
    await feishu.sendStreamingUpdate(target, '片段', 'stream-1', false);
    expect(feishuTransport.sent[0]).toMatchObject({ kind: 'stream', streamId: 'stream-1', final: false });

    const telegram = createChannelAdapter({ provider: 'telegram', capabilities: CHANNEL_CAPABILITIES.telegram, transport: new FakeTransport() });
    await telegram.connect({ accountId: 'ca_telegram', credentials: {} });
    await expect(telegram.sendStreamingUpdate('telegram:100#account:ca_telegram', '片段', 'stream-1', false)).rejects.toThrow('不支持');
  });
});
