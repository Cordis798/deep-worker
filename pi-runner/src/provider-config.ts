import fs from 'node:fs/promises';
import path from 'node:path';

export type PiModelApi =
  'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';

export interface PiProviderModelConfig {
  baseUrl: string;
  api: PiModelApi;
  apiKeyEnv: string;
  input?: Array<'text' | 'image'>;
}

export interface PiProviderConfigSelection {
  provider: string;
  modelId: string;
  modelConfig?: PiProviderModelConfig;
}

/**
 * 为独立 Pi 会话生成 models.json。API Key 只保留环境变量引用，绝不写入文件。
 */
export async function materializePiProviderConfig(
  selection: PiProviderConfigSelection | undefined,
  sessionRoot: string,
): Promise<string | undefined> {
  if (!selection?.modelConfig) return undefined;
  const configDir = path.join(sessionRoot, 'pi-config');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = selection.modelConfig;
  const config = {
    providers: {
      [selection.provider]: {
        baseUrl: model.baseUrl,
        api: model.api,
        apiKey: `$${model.apiKeyEnv}`,
        ...(model.api === 'openai-completions'
          ? {
              compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
              },
            }
          : {}),
        models: [
          {
            id: selection.modelId,
            name: selection.modelId,
            reasoning: false,
            input: model.input ?? ['text'],
          },
        ],
      },
    },
  };
  await fs.writeFile(
    path.join(configDir, 'models.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  return configDir;
}
