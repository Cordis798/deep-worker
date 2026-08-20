import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../fake-transport.js';
import { createDiscordAdapter } from './discord.js';

describe('Discord 渠道适配器', () => {
  it('将 DM 地址纳入稳定账号作用域并完成回复', async () => {
    const transport = new FakeTransport();
    const adapter = createDiscordAdapter(transport);
    let jid = '';
    adapter.onMessage((message) => { jid = message.chatJid; });
    await adapter.connect({ accountId: 'ca_dc', credentials: {} });
    transport.emitMessage({ externalChatId: 'dm:100', conversation: 'group', senderId: 'u', text: '私聊' });
    expect(jid).toContain('discord:dm%3A100#account:ca_dc');
    await adapter.sendMessage(jid, '回复');
    expect(transport.sent[0]).toMatchObject({ kind: 'message', target: { externalChatId: 'dm:100' } });
  });
});
