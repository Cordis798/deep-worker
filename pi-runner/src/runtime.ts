import type { PiCapabilityInjection } from './capability-injection.js';
import type { PiProviderSelection } from './runner.js';

export interface RuntimeInput {
  text: string;
}

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface RuntimeResult {
  text: string;
  sessionId: string;
  finalizationReason: 'completed' | 'interrupted' | 'error';
  stopReason?: string;
  usage?: RuntimeUsage;
  error?: string;
}

export type RuntimeEvent =
  | { type: 'text_delta' | 'thinking_delta'; sessionId: string; delta: string }
  | {
      type: 'tool_start' | 'tool_update' | 'tool_end';
      sessionId: string;
      toolName: string;
      toolCallId: string;
      input?: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | { type: 'status'; sessionId: string; statusText: string }
  | { type: 'result'; sessionId: string; result: RuntimeResult };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface RuntimeSessionOptions {
  sessionId: string;
  cwd: string;
  sessionDir: string;
  sessionFile?: string;
  systemPrompt?: string;
  provider?: PiProviderSelection;
  capabilities?: PiCapabilityInjection;
}

export interface RuntimeSession {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  prompt(input: RuntimeInput): Promise<RuntimeResult>;
  steer(input: RuntimeInput): Promise<RuntimeResult>;
  followUp(input: RuntimeInput): Promise<RuntimeResult>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  dispose(): Promise<void> | void;
}

export interface AgentRuntime {
  readonly kind: 'pi';
  createSession(options: RuntimeSessionOptions): Promise<RuntimeSession>;
  close(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function textFromRuntimeMessage(message: unknown): string {
  const content = record(message)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const block = record(item);
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

export function resultFromAssistantMessage(
  message: unknown,
  sessionId: string,
): RuntimeResult {
  const source = record(message);
  const stopReason =
    typeof source?.stopReason === 'string' ? source.stopReason : undefined;
  const usage = record(source?.usage);
  const inputTokens = finite(usage?.input);
  const outputTokens = finite(usage?.output);
  const cost = record(usage?.cost);
  const runtimeUsage =
    inputTokens !== undefined && outputTokens !== undefined
      ? {
          inputTokens,
          outputTokens,
          cacheReadInputTokens: finite(usage?.cacheRead),
          cacheCreationInputTokens: finite(usage?.cacheWrite),
          costUSD: finite(cost?.total),
        }
      : undefined;
  return {
    text: textFromRuntimeMessage(message),
    sessionId,
    finalizationReason:
      stopReason === 'aborted'
        ? 'interrupted'
        : stopReason === 'error'
          ? 'error'
          : 'completed',
    ...(stopReason ? { stopReason } : {}),
    ...(runtimeUsage ? { usage: runtimeUsage } : {}),
    ...(typeof source?.errorMessage === 'string'
      ? { error: source.errorMessage }
      : {}),
  };
}
