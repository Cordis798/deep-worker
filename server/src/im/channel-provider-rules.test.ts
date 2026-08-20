import { describe, expect, it } from 'vitest';
import { inferConversation, normalizeProviderInbound } from './channel-provider-rules.js';

describe('渠道地址与会话类型规则', () => {
  it.each([
    ['telegram', '-100', 'group'],
    ['telegram', '100', 'private'],
    ['discord', 'dm:100', 'private'],
    ['whatsapp', '100@g.us', 'group'],
    ['whatsapp', '100@s.whatsapp.net', 'private'],
    ['qq', 'group:100', 'group'],
    ['qq', 'c2c:100', 'private'],
    ['dingtalk', 'c2c:100', 'private'],
    ['dingtalk', 'conversation:100', 'group'],
  ] as const)('%s 的 %s 会话识别为 %s', (provider, externalChatId, expected) => {
    expect(inferConversation(provider, externalChatId)).toBe(expected);
  });

  it('微信拒绝群聊入站，无法推断的自定义测试地址保留 Transport 声明', () => {
    expect(normalizeProviderInbound('wechat', { externalChatId: 'group', conversation: 'group', senderId: 'u', text: '' })).toBeNull();
    expect(normalizeProviderInbound('telegram', { externalChatId: 'opaque', conversation: 'group', senderId: 'u', text: '' })?.conversation).toBe('group');
  });
});
