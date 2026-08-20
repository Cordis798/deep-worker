import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../fake-transport.js';
import { createDingTalkAdapter } from './dingtalk.js';

describe('钉钉渠道适配器', () => {
  it('区分 C2C 地址并支持图片投递', async () => {
    const transport = new FakeTransport();
    const adapter = createDingTalkAdapter(transport);
    let jid = '';
    adapter.onMessage((message) => { jid = message.chatJid; });
    await adapter.connect({ accountId: 'ca_dt', credentials: {} });
    transport.emitMessage({ externalChatId: 'c2c:100', conversation: 'group', senderId: 'u', text: '私聊' });
    expect(jid).toContain('dingtalk:c2c%3A100#account:ca_dt');
    await adapter.sendImage(jid, new Uint8Array([1]), 'image/png', '图片');
    expect(transport.sent[0]).toMatchObject({ kind: 'image', mimeType: 'image/png' });
  });
});
