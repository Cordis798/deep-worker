import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../fake-transport.js';
import { createWeChatAdapter } from './wechat.js';

describe('微信渠道适配器', () => {
  it('保留私聊能力并拒绝群聊入站与文件投递', async () => {
    const transport = new FakeTransport();
    const adapter = createWeChatAdapter(transport);
    const messages: string[] = [];
    adapter.onMessage((message) => messages.push(message.chatJid));
    await adapter.connect({ accountId: 'ca_wc', credentials: {} });
    transport.emitMessage({ externalChatId: 'group', conversation: 'group', senderId: 'u', text: '群聊' });
    expect(messages).toHaveLength(0);
    transport.emitMessage({ externalChatId: 'user', conversation: 'private', senderId: 'u', text: '私聊' });
    await expect(adapter.sendFile(messages[0]!, 'a.txt', 'a.txt')).rejects.toThrow('不支持');
  });
});
