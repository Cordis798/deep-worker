import { describe, expect, it } from 'vitest';
import { hostName, redactConfig, resolveConfig, runnerMode, webPort } from './config.js';

describe('config', () => {
  it('resolves persistent setting over env over default', () => {
    expect(resolveConfig('persist', 'env', 'default')).toBe('persist');
    expect(resolveConfig(null, 'env', 'default')).toBe('env');
    expect(resolveConfig(null, null, 'default')).toBe('default');
  });

  it('reads WEB_PORT from env and falls back to the default', () => {
    expect(webPort({ WEB_PORT: '4321' })).toBe(4321);
    expect(webPort({})).toBe(3000);
    expect(webPort({ WEB_PORT: 'not-a-number' })).toBe(3000);
  });

  it('reads HOST from env with a default', () => {
    expect(hostName({ HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(hostName({})).toBe('0.0.0.0');
  });

  it('only enables the deterministic runner with an explicit fake mode', () => {
    expect(runnerMode({ DEEP_WORKER_RUNNER: 'fake' })).toBe('fake');
    expect(runnerMode({ DEEP_WORKER_RUNNER: 'pi' })).toBe('pi');
    expect(runnerMode({})).toBe('pi');
  });

  it('redacts sensitive config keys', () => {
    const out = redactConfig({
      WEB_SESSION_SECRET: 'abc',
      apiKey: 'k',
      bot_token: 't',
      port: 8080,
    });
    expect(out.WEB_SESSION_SECRET).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.bot_token).toBe('[REDACTED]');
    expect(out.port).toBe(8080);
  });
});
