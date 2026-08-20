import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../fake-transport.js';
import { createTelegramAdapter } from './telegram.js';

describe('Telegram 渠道适配器', () => {
  it('识别负数群聊并在重连后保留账号地址', async () => {
    const transport = new FakeTransport();
    const adapter = createTelegramAdapter(transport);
    const messages: string[] = [];
    adapter.onMessage((message) => messages.push(message.chatJid));
    await adapter.connect({ accountId: 'ca_tg', credentials: {} });
    transport.emitMessage({ externalChatId: '-100', conversation: 'private', senderId: 'u', text: '群消息' });
    expect(messages[0]).toContain('telegram:-100#account:ca_tg');
    await adapter.sendMessage(messages[0]!, '回复');
    transport.dropConnection();
    await adapter.reconnect();
    expect(adapter.getStatus().status).toBe('connected');
  });
});
