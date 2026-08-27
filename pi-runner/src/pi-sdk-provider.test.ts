import { describe, expect, it, vi } from 'vitest';
import { resolvePiSdkModel, type PiModelRuntimeLike } from './pi-sdk-provider.js';

function fakeRuntime(): PiModelRuntimeLike & {
  registerProvider: ReturnType<typeof vi.fn>;
  setRuntimeApiKey: ReturnType<typeof vi.fn>;
} {
  const models = new Map<string, unknown>([
    ['anthropic/model-a', { provider: 'anthropic', id: 'model-a' }],
  ]);
  return {
    getModel: vi.fn((provider: string, modelId: string) =>
      models.get(`${provider}/${modelId}`),
    ),
    registerProvider: vi.fn((provider: string, config: { models: Array<{ id: string }> }) => {
      models.set(`${provider}/${config.models[0].id}`, {
        provider,
        id: config.models[0].id,
      });
    }),
    setRuntimeApiKey: vi.fn(async () => undefined),
  };
}

describe('resolvePiSdkModel', () => {
  it('uses a runtime-only key for a built-in provider', async () => {
    const runtime = fakeRuntime();

    await expect(
      resolvePiSdkModel(runtime, {
        provider: 'anthropic',
        modelId: 'model-a',
        env: { ANTHROPIC_API_KEY: 'secret' },
      }),
    ).resolves.toEqual({ provider: 'anthropic', id: 'model-a' });
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'secret');
  });

  it('registers a custom provider without persisting its key', async () => {
    const runtime = fakeRuntime();

    await expect(
      resolvePiSdkModel(runtime, {
        provider: 'openai-proxy',
        modelId: 'model-b',
        env: { OPENAI_PROXY_API_KEY: 'secret' },
        modelConfig: {
          baseUrl: 'https://example.test/v1',
          api: 'openai-completions',
          apiKeyEnv: 'OPENAI_PROXY_API_KEY',
          input: ['text'],
        },
      }),
    ).resolves.toEqual({ provider: 'openai-proxy', id: 'model-b' });
    expect(runtime.registerProvider).toHaveBeenCalledWith(
      'openai-proxy',
      expect.objectContaining({
        baseUrl: 'https://example.test/v1',
        apiKey: 'secret',
        api: 'openai-completions',
      }),
    );
  });

  it('fails closed when the selected model is unavailable', async () => {
    const runtime = fakeRuntime();
    await expect(
      resolvePiSdkModel(runtime, { provider: 'missing', modelId: 'none' }),
    ).rejects.toThrow('Pi SDK model not found: missing/none');
  });
});
