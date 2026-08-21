import { describe, expect, it, vi } from 'vitest';
import { mapProviderToPiProvider, ProviderPool } from './provider-pool.js';
import type { ProviderConfigRow } from './provider-store.js';

function provider(id: string, weight = 1): ProviderConfigRow {
  return {
    id,
    owner_user_id: 'u',
    name: id,
    provider: id,
    model_id: `${id}-model`,
    base_url: null,
    secret_ref: '',
    enabled: 1,
    weight,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('ProviderPool', () => {
  it('按 round-robin 轮转并保持会话粘性', () => {
    const pool = new ProviderPool();
    pool.refreshFromConfig([provider('one'), provider('two')], { strategy: 'round-robin' });
    expect(pool.selectProvider('session-a')?.id).toBe('one');
    expect(pool.selectProvider('session-a')?.id).toBe('one');
    expect(pool.selectProvider('session-b')?.id).toBe('two');
  });

  it('按权重选择并在失败后切换到健康 Provider', () => {
    const pool = new ProviderPool();
    pool.refreshFromConfig([provider('heavy', 2), provider('light', 1)], {
      strategy: 'weighted',
      unhealthyThreshold: 1,
    });
    expect([
      pool.selectProvider('a')?.id,
      pool.selectProvider('b')?.id,
      pool.selectProvider('c')?.id,
    ]).toEqual(['heavy', 'heavy', 'light']);
    pool.reportFailure('heavy', true);
    expect(pool.selectProvider('a')?.id).toBe('light');
  });

  it('按 failover 顺序恢复不健康 Provider', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-21T10:00:00.000Z'));
      const pool = new ProviderPool();
      pool.refreshFromConfig([provider('primary'), provider('backup')], {
        strategy: 'failover',
        unhealthyThreshold: 1,
        recoveryIntervalMs: 60_000,
      });
      pool.reportFailure('primary', true);
      expect(pool.selectProvider('s')?.id).toBe('backup');
      vi.advanceTimersByTime(60_000);
      pool.refreshRecoveryState();
      expect(pool.getHealth('primary').healthy).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('映射 Pi Provider 时只输出允许的凭据环境变量，不暴露密文', () => {
    const mapped = mapProviderToPiProvider(
      { ...provider('openai'), base_url: 'https://example.test', secret_ref: 'v1.secret' },
      { apiKey: 'secret-value', ignored: 'not-exported' },
    );
    expect(mapped).toMatchObject({ provider: 'openai', modelId: 'openai-model' });
    expect(mapped.env).toEqual({
      OPENAI_API_KEY: 'secret-value',
      OPENAI_BASE_URL: 'https://example.test',
    });
    expect(mapped.modelConfig).toEqual({
      baseUrl: 'https://example.test',
      api: 'openai-completions',
      apiKeyEnv: 'OPENAI_API_KEY',
      input: ['text'],
    });
    expect(JSON.stringify(mapped)).not.toContain('v1.secret');
    expect(JSON.stringify(mapped)).not.toContain('ignored');
  });

  it('为视觉模型声明图片输入，但 models.json 仅引用密钥环境变量', () => {
    const mapped = mapProviderToPiProvider(
      {
        ...provider('deepseek'),
        model_id: 'deepseek-vision',
        base_url: 'https://api.deepseek.com',
      },
      { apiKey: 'secret-value' },
    );
    expect(mapped.modelConfig?.input).toEqual(['text', 'image']);
    expect(JSON.stringify(mapped.modelConfig)).not.toContain('secret-value');
  });
});
