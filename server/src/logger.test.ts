import { describe, expect, it } from 'vitest';
import {
  redactLogMessage,
  sanitizeLogObject,
  serializeErrorForLog,
} from './logger.js';

describe('logger sanitization', () => {
  it('redacts bearer tokens and sk- API keys in messages', () => {
    const out = redactLogMessage(
      'request failed: Authorization: Bearer abcDEF123 and key sk-ant-abcdefghijklmnop',
    );
    expect(out).not.toContain('abcDEF123');
    expect(out).not.toContain('sk-ant-');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts password assignments and JWT-like tokens', () => {
    const out = redactLogMessage('password=hunter2 token=eyJ.aaa.bbb');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('eyJ');
    expect(out).toContain('[REDACTED]');
  });

  it('sanitizes nested log objects and masks sensitive keys', () => {
    const out = sanitizeLogObject({
      user: { name: 'alice' },
      token: 'sk-abcdefghijklmnopqrst',
      nested: { password: 'p', headers: { authorization: 'Bearer x' } },
    });
    expect(out.user).toEqual({ name: 'alice' });
    expect(out.token).toBe('[REDACTED]');
    expect(out.nested).toEqual({
      password: '[REDACTED]',
      headers: { authorization: '[REDACTED]' },
    });
  });

  it('serializes errors without leaking credentials', () => {
    const error = new Error('boom token=secretvalue');
    const out = serializeErrorForLog(error);
    expect(out.message).toContain('[REDACTED]');
    expect(out.message).not.toContain('secretvalue');
    expect(out.name).toBe('Error');
  });
});
