import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../fake-transport.js';
import { createWhatsAppAdapter } from './whatsapp.js';

describe('WhatsApp 渠道适配器', () => {
  it('保留 WhatsApp 群组地址并支持文件投递', async () => {
    const transport = new FakeTransport();
    const adapter = createWhatsAppAdapter(transport);
    let jid = '';
    adapter.onMessage((message) => { jid = message.chatJid; });
    await adapter.connect({ accountId: 'ca_wa', credentials: {} });
    transport.emitMessage({ externalChatId: '123@g.us', conversation: 'private', senderId: 'u', text: '群组' });
    expect(jid).toContain('whatsapp:123%40g.us#account:ca_wa');
    await adapter.sendFile(jid, 'a.txt', 'a.txt');
    expect(transport.sent[0]).toMatchObject({ kind: 'file', fileName: 'a.txt' });
  });
});
