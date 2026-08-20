import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../fake-transport.js';
import { createFeishuAdapter } from './feishu.js';

describe('飞书渠道适配器', () => {
  it('保留话题和根消息，并支持流式更新', async () => {
    const transport = new FakeTransport();
    const adapter = createFeishuAdapter(transport);
    let jid = '';
    adapter.onMessage((message) => { jid = message.chatJid; });
    await adapter.connect({ accountId: 'ca_fs', credentials: {} });
    transport.emitMessage({ externalChatId: 'oc_group', conversation: 'group', senderId: 'u', text: '话题', threadId: 'topic/1', rootMessageId: 'root/1' });
    expect(jid).toContain('thread:topic%2F1#root:root%2F1');
    await adapter.sendStreamingUpdate(jid, '片段', 'card-1', false);
    expect(transport.sent[0]).toMatchObject({ kind: 'stream', streamId: 'card-1' });
  });
});
