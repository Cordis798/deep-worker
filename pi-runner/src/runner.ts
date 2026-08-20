import type { StreamEvent } from '@deep-worker/shared';
import { PiSessionManager, type SessionClient, type SessionConfig } from './session-manager.js';
import { extractFinalReply } from './output-parser.js';
import { assemblePrompt, type PromptMessage } from './prompt.js';
import { SessionQueue, type SessionQueueOptions } from './session-queue.js';
import { mapPiEvent } from './stream-events.js';
import type { RpcEvent } from './rpc-types.js';

export interface AgentRunRequest {
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
}

/** 基于 Pi 的智能体运行器，按会话串行执行并限制重试次数。 */
export class PiRunner implements AgentRunner {
  private readonly sessions: PiSessionManager;
  private readonly queue: SessionQueue;

  constructor(options: PiRunnerOptions) {
    this.sessions =
      options.sessionManager ?? new PiSessionManager({ baseDir: options.baseDir });
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
    await this.sessions.closeAll();
  }

  private async runOnce(
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
    };
    const prompt = assemblePrompt({
      systemPrompt: request.systemPrompt,
      history: request.history,
      currentMessage: request.message,
      outputContract: request.outputContract ?? 'Return the final answer only.',
    });
    const rawEvents: RpcEvent[] = [];
    const events: StreamEvent[] = [];
    try {
      let reply = '';
      await this.sessions.withSession(config, async (client) => {
        if (!client.promptAndWait) {
          throw new Error('Pi session client does not support promptAndWait');
        }
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
        });
        if (rawEvents.length === 0) rawEvents.push(...completedEvents);
        reply = extractFinalReply(rawEvents);
        if (!reply && client.getLastAssistantText) {
          reply = (await client.getLastAssistantText()) ?? '';
        }
      });
      return { sessionId: request.sessionId, reply, events, attempts: 1 };
    } catch (error) {
      await this.sessions.invalidate(request.sessionId);
      throw error;
    }
  }
}

export interface FakePiRunnerOptions {
  response?: string | ((request: AgentRunRequest) => string);
  delayMs?: number;
  failuresBeforeSuccess?: number;
  emitBash?: boolean;
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
    if (this.options.delayMs > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, this.options.delayMs));
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
