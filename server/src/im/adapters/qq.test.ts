import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../fake-transport.js';
import { createQqAdapter } from './qq.js';

describe('QQ 渠道适配器', () => {
  it('识别群聊地址并支持 Reaction', async () => {
    const transport = new FakeTransport();
    const adapter = createQqAdapter(transport);
    let jid = '';
    adapter.onMessage((message) => { jid = message.chatJid; });
    await adapter.connect({ accountId: 'ca_qq', credentials: {} });
    transport.emitMessage({ externalChatId: 'group:100', conversation: 'private', senderId: 'u', text: '群聊' });
    expect(jid).toContain('qq:group%3A100#account:ca_qq');
    await adapter.react(jid, '👍');
    expect(transport.sent[0]).toMatchObject({ kind: 'reaction', reaction: '👍' });
  });
});
