import { describe, expect, it } from 'vitest';
import { decryptChannelCredentials, encryptChannelCredentials } from './channel-secrets.js';

describe('渠道凭据保护', () => {
  it('使用 AES-GCM 往返凭据且密文不包含明文 token', () => {
    const credentials = { token: 'secret-token', appId: 'app-1', nested: { enabled: true } };
    const encrypted = encryptChannelCredentials(credentials);
    expect(encrypted).not.toContain('secret-token');
    expect(decryptChannelCredentials(encrypted)).toEqual(credentials);
  });

  it('拒绝被篡改或格式不正确的密文', () => {
    const encrypted = encryptChannelCredentials({ token: 'secret-token' });
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('a') ? 'b' : 'a'}`;
    expect(() => decryptChannelCredentials(tampered)).toThrow();
    expect(() => decryptChannelCredentials('not-a-channel-secret')).toThrow();
  });
});
