import type { StreamEvent } from '@deep-worker/shared';
import { PiSessionManager, type SessionClient, type SessionConfig } from './session-manager.js';
import { extractFinalReply } from './output-parser.js';
import { assemblePrompt, type PromptMessage } from './prompt.js';
import { SessionQueue, type SessionQueueOptions } from './session-queue.js';
import { mapPiEvent } from './stream-events.js';
import type { RpcEvent } from './rpc-types.js';
import type { PiCapabilityInjection } from './capability-injection.js';
import type { PiProviderModelConfig } from './provider-config.js';
import type { AgentRuntime, RuntimeResult, RuntimeSession } from './runtime.js';
import { PiSdkRuntimeAdapter } from './pi-sdk-runtime.js';
import { RuntimeSessionManager } from './runtime-session-manager.js';
import { mapRuntimeEvent } from './runtime-stream-events.js';

export interface AgentRunRequest {
  ownerUserId?: string;
  sessionId: string;
  message: string;
  cwd?: string;
  sessionDir?: string;
  sessionFile?: string;
  identityHash?: string;
  capabilityHash?: string;
  systemPrompt?: string;
  history?: PromptMessage[];
  outputContract?: string;
  turnId?: string;
  queryRunId?: string;
  timeoutMs?: number;
  capabilities?: PiCapabilityInjection;
  toolPolicy?: 'read' | 'write';
  provider?: PiProviderSelection;
  containerMounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
  containerLimits?: { memoryMb?: number; cpus?: number; pids?: number; tmpfsMb?: number };
  abortSignal?: AbortSignal;
}

export interface PiProviderSelection {
  provider: string;
  modelId: string;
  env?: NodeJS.ProcessEnv;
  hash?: string;
  modelConfig?: PiProviderModelConfig;
}

export interface AgentRunResult {
  sessionId: string;
  reply: string;
  events: StreamEvent[];
  attempts: number;
}

export type AgentEventListener = (event: StreamEvent) => void;

export interface AgentRunner {
  run(request: AgentRunRequest, onEvent?: AgentEventListener): Promise<AgentRunResult>;
  close(): Promise<void>;
}

export interface PiRunnerOptions {
  baseDir: string;
  queueOptions?: SessionQueueOptions;
  sessionManager?: PiSessionManager;
  runtime?: AgentRuntime;
}

/** 基于 Pi 的智能体运行器，按会话串行执行并限制重试次数。 */
export class PiRunner implements AgentRunner {
  private readonly legacySessions?: PiSessionManager;
  private readonly runtimeSessions?: RuntimeSessionManager;
  private readonly queue: SessionQueue;

  constructor(options: PiRunnerOptions) {
    if (options.runtime || !options.sessionManager) {
      this.runtimeSessions = new RuntimeSessionManager({
        baseDir: options.baseDir,
        runtime: options.runtime ?? new PiSdkRuntimeAdapter(),
      });
    } else {
      // Explicit injection keeps the old client seam available for compatibility tests only.
      this.legacySessions = options.sessionManager;
    }
    this.queue = new SessionQueue(options.queueOptions);
  }

  async run(request: AgentRunRequest, onEvent?: AgentEventListener): Promise<AgentRunResult> {
    const result = await this.queue.enqueue(request.sessionId, () =>
      this.runOnce(request, onEvent),
    );
    return { ...result.value, attempts: result.attempts };
  }

  async close(): Promise<void> {
    this.queue.close();
    await this.runtimeSessions?.closeAll();
    await this.legacySessions?.closeAll();
  }

  private async runOnce(
    request: AgentRunRequest,
    onEvent?: AgentEventListener,
  ): Promise<AgentRunResult> {
    if (this.runtimeSessions) return this.runSdkOnce(request, onEvent);
    return this.runLegacyOnce(request, onEvent);
  }

  private async runSdkOnce(
    request: AgentRunRequest,
    onEvent?: AgentEventListener,
  ): Promise<AgentRunResult> {
    const prompt = assemblePrompt({
      history: request.history,
      currentMessage: request.message,
      outputContract: request.outputContract ?? 'Return the final answer only.',
      capabilities: request.capabilities
        ? {
            hash: request.capabilities.hash,
            skills: request.capabilities.skills.map((skill) => skill.name),
            mcpServers: request.capabilities.mcpServers.map((server) => server.name),
            plugins: request.capabilities.plugins
              .filter((plugin) => plugin.enabled)
              .map((plugin) => plugin.name),
          }
        : undefined,
    });
    const events: StreamEvent[] = [];
    try {
      const result = await this.runtimeSessions!.withSession(
        {
          sessionId: request.sessionId,
          cwd: request.cwd,
          sessionDir: request.sessionDir,
          sessionFile: request.sessionFile,
          identityHash: request.identityHash,
          capabilityHash: request.capabilityHash,
          providerHash: request.provider?.hash,
          systemPrompt: request.systemPrompt,
          provider: request.provider,
          capabilities: request.capabilities,
          allowedTools: request.toolPolicy === 'read' ? [] : ['bash'],
        },
        async (session) => {
          const unsubscribe = session.subscribe((runtimeEvent) => {
            for (const event of mapRuntimeEvent(runtimeEvent, {
              sessionId: request.sessionId,
              turnId: request.turnId,
              queryRunId: request.queryRunId,
            })) {
              events.push(event);
              onEvent?.(event);
            }
          });
          try {
            return await this.promptSdkSession(session, prompt, request.timeoutMs, request.abortSignal);
          } finally {
            unsubscribe();
          }
        },
      );
      if (result.finalizationReason === 'error') {
        throw new Error(result.error ?? `Pi SDK stopped with ${result.stopReason ?? 'error'}`);
      }
      return {
        sessionId: request.sessionId,
        reply: result.text,
        events,
        attempts: 1,
      };
    } catch (error) {
      await this.runtimeSessions!.invalidate(request.sessionId);
      throw error;
    }
  }

  private async promptSdkSession(
    session: RuntimeSession,
    prompt: string,
    timeoutMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<RuntimeResult> {
    if (abortSignal?.aborted) {
      await session.abort().catch(() => undefined);
      throw new Error('Pi SDK prompt aborted');
    }
    let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const abortPromise = abortSignal
      ? new Promise<never>((_resolve, reject) => {
          abortHandler = () => {
            void session.abort().catch(() => undefined);
            reject(new Error('Pi SDK prompt aborted'));
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        })
      : undefined;
    try {
      const promptPromise = session.prompt({ text: prompt });
      if (!timeoutMs && !abortPromise) return await promptPromise;
      return await Promise.race([
        promptPromise,
        ...(timeoutMs ? [new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void session.abort().catch(() => undefined);
            reject(new Error(`Pi SDK prompt timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })] : []),
        ...(abortPromise ? [abortPromise] : []),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortHandler) abortSignal?.removeEventListener('abort', abortHandler);
    }
  }

  private async runLegacyOnce(
    request: AgentRunRequest,
    onEvent?: AgentEventListener,
  ): Promise<AgentRunResult> {
    const config: SessionConfig = {
      sessionId: request.sessionId,
      cwd: request.cwd,
      sessionDir: request.sessionDir,
      sessionFile: request.sessionFile,
      identityHash: request.identityHash,
      capabilityHash: request.capabilityHash,
      capabilities: request.capabilities,
      providerHash: request.provider?.hash,
      provider: request.provider,
      env: request.provider?.env,
    };
    const prompt = assemblePrompt({
      systemPrompt: request.systemPrompt,
      history: request.history,
      currentMessage: request.message,
      outputContract: request.outputContract ?? 'Return the final answer only.',
      capabilities: request.capabilities
        ? {
            hash: request.capabilities.hash,
            skills: request.capabilities.skills.map((skill) => skill.name),
            mcpServers: request.capabilities.mcpServers.map((server) => server.name),
            plugins: request.capabilities.plugins
              .filter((plugin) => plugin.enabled)
              .map((plugin) => plugin.name),
          }
        : undefined,
    });
    const rawEvents: RpcEvent[] = [];
    const events: StreamEvent[] = [];
    try {
      let reply = '';
      await this.legacySessions!.withSession(config, async (client) => {
        if (!client.promptAndWait) {
          throw new Error('Pi session client does not support promptAndWait');
        }
        if (request.provider && client.setModel) {
          await client.setModel(request.provider.provider, request.provider.modelId);
        }
        const abortHandler = request.abortSignal ? () => { void this.legacySessions!.invalidate(request.sessionId); } : undefined;
        if (abortHandler) request.abortSignal!.addEventListener('abort', abortHandler, { once: true });
        const completedEvents = await client.promptAndWait(prompt, {
          timeoutMs: request.timeoutMs,
          onEvent: (rawEvent) => {
            rawEvents.push(rawEvent);
            for (const event of mapPiEvent(rawEvent, {
              sessionId: request.sessionId,
              turnId: request.turnId,
              queryRunId: request.queryRunId,
            })) {
              events.push(event);
              onEvent?.(event);
            }
          },
        }).finally(() => {
          if (abortHandler) request.abortSignal?.removeEventListener('abort', abortHandler);
        });
        if (rawEvents.length === 0) rawEvents.push(...completedEvents);
        reply = extractFinalReply(rawEvents);
        if (!reply && client.getLastAssistantText) {
          reply = (await client.getLastAssistantText()) ?? '';
        }
      });
      return { sessionId: request.sessionId, reply, events, attempts: 1 };
    } catch (error) {
      await this.legacySessions!.invalidate(request.sessionId);
      throw error;
    }
  }
}

export interface FakePiRunnerOptions {
  response?: string | ((request: AgentRunRequest) => string);
  delayMs?: number;
  failuresBeforeSuccess?: number;
  emitBash?: boolean;
  emitUsage?: boolean;
}

/** 用于测试和本地开发的确定性运行器，不需要接口密钥。 */
export class FakePiRunner implements AgentRunner {
  readonly calls: AgentRunRequest[] = [];
  private readonly options: Required<
    Pick<FakePiRunnerOptions, 'delayMs' | 'failuresBeforeSuccess'>
  > &
    FakePiRunnerOptions;
  private failures = 0;

  constructor(options: FakePiRunnerOptions = {}) {
    this.options = { delayMs: 0, failuresBeforeSuccess: 0, ...options };
  }

  async run(request: AgentRunRequest, onEvent?: AgentEventListener): Promise<AgentRunResult> {
    this.calls.push(request);
    if (request.abortSignal?.aborted) throw new Error('fake runner aborted');
    if (this.options.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('fake runner aborted'));
        };
        request.abortSignal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (this.failures < this.options.failuresBeforeSuccess) {
      this.failures += 1;
      throw new Error('fake temporary failure');
    }
    const reply =
      typeof this.options.response === 'function'
        ? this.options.response(request)
        : (this.options.response ?? `Fake reply: ${request.message}`);
    const events: StreamEvent[] = [
      {
        eventType: 'init',
        sessionId: request.sessionId,
        turnId: request.turnId,
        queryRunId: request.queryRunId,
        isSynthetic: true,
        statusText: 'fake runner started',
      },
    ];
    if (this.options.emitBash) {
      events.push(
        {
          eventType: 'tool_use_start',
          sessionId: request.sessionId,
          turnId: request.turnId,
          toolName: 'bash',
          toolUseId: 'fake-bash',
          toolInput: { command: 'echo fake' },
          isSynthetic: true,
        },
        {
          eventType: 'tool_result',
          sessionId: request.sessionId,
          turnId: request.turnId,
          toolName: 'bash',
          toolUseId: 'fake-bash',
          toolResult: 'fake\n',
          isSynthetic: true,
        },
      );
    }
    for (const chunk of reply.match(/.{1,8}/gs) ?? [reply]) {
      const event: StreamEvent = {
        eventType: 'text_delta',
        sessionId: request.sessionId,
        turnId: request.turnId,
        queryRunId: request.queryRunId,
        text: chunk,
        isSynthetic: true,
      };
      events.push(event);
    }
    if (this.options.emitUsage) {
      events.push({
        eventType: 'usage',
        sessionId: request.sessionId,
        turnId: request.turnId,
        queryRunId: request.queryRunId,
        usage: {
          inputTokens: Math.max(1, Math.ceil(request.message.length / 4)),
          outputTokens: Math.max(1, Math.ceil(reply.length / 4)),
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          durationMs: this.options.delayMs,
        },
        isSynthetic: true,
      });
    }
    events.push({
      eventType: 'status',
      sessionId: request.sessionId,
      turnId: request.turnId,
      statusText: 'fake runner settled',
      isSynthetic: true,
    });
    for (const event of events) onEvent?.(event);
    return { sessionId: request.sessionId, reply, events, attempts: 1 };
  }

  async close(): Promise<void> {
    // 模拟运行器不持有进程资源。
  }
}
