import type { PiProviderSelection } from './runner.js';

interface RegisteredProviderConfig {
  name: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: Array<{
    id: string;
    name: string;
    api: string;
    reasoning: boolean;
    input: Array<'text' | 'image'>;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
}

export interface PiModelRuntimeLike {
  getModel(provider: string, modelId: string): unknown;
  registerProvider(provider: string, config: RegisteredProviderConfig): void;
  setRuntimeApiKey(provider: string, apiKey: string): Promise<void>;
}

function providerEnvName(provider: string): string {
  return `${provider.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_API_KEY`;
}

export async function resolvePiSdkModel(
  runtime: PiModelRuntimeLike,
  selection: PiProviderSelection,
): Promise<unknown> {
  const config = selection.modelConfig;
  const keyName = config?.apiKeyEnv ?? providerEnvName(selection.provider);
  const apiKey = selection.env?.[keyName] ?? process.env[keyName];

  if (config) {
    runtime.registerProvider(selection.provider, {
      name: `Deep Worker ${selection.provider}`,
      baseUrl: config.baseUrl,
      api: config.api,
      ...(apiKey ? { apiKey } : {}),
      models: [
        {
          id: selection.modelId,
          name: selection.modelId,
          api: config.api,
          reasoning: false,
          input: config.input ?? ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ],
    });
  } else if (apiKey) {
    await runtime.setRuntimeApiKey(selection.provider, apiKey);
  }

  const model = runtime.getModel(selection.provider, selection.modelId);
  if (!model) {
    throw new Error(
      `Pi SDK model not found: ${selection.provider}/${selection.modelId}`,
    );
  }
  return model;
}
