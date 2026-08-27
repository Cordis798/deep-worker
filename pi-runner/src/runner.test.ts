import { describe, expect, it } from 'vitest';
import { PiRunner, type AgentRunRequest } from './runner.js';
import { PiSessionManager, type SessionClient } from './session-manager.js';
import type { AgentRuntime, RuntimeEventListener, RuntimeSession } from './runtime.js';

class FakeClient implements SessionClient {
  readonly prompts: string[] = [];
  readonly fail: boolean;
  closed = false;

  constructor(fail = false) {
    this.fail = fail;
  }

  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  async getState(): Promise<{ sessionId: string }> {
    return { sessionId: 'fake' };
  }
  async promptAndWait(
    message: string,
    options?: { onEvent?: (event: { type: string; [key: string]: unknown }) => void },
  ): Promise<Array<{ type: string; [key: string]: unknown }>> {
    this.prompts.push(message);
    if (this.fail) throw new Error('temporary fake failure');
    const events = [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
      { type: 'message_end', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'agent_settled' },
    ];
    for (const event of events) options?.onEvent?.(event);
    return events;
  }
}

describe('PiRunner', () => {
  it('runs normal conversations through the direct SDK runtime', async () => {
    const listeners = new Set<RuntimeEventListener>();
    const session: RuntimeSession = {
      sessionId: 'sdk-session',
      isStreaming: false,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        for (const listener of listeners) {
          listener({ type: 'text_delta', sessionId: 'sdk-session', delta: 'sdk' });
        }
        const result = {
          text: 'sdk reply',
          sessionId: 'sdk-session',
          finalizationReason: 'completed' as const,
          usage: { inputTokens: 2, outputTokens: 3 },
        };
        for (const listener of listeners) {
          listener({ type: 'result', sessionId: 'sdk-session', result });
        }
        return result;
      },
      async steer() {
        throw new Error('not used');
      },
      async followUp() {
        throw new Error('not used');
      },
      async abort() {},
      async compact() {},
      dispose() {},
    };
    const runtime: AgentRuntime = {
      kind: 'pi',
      createSession: async () => session,
      close: async () => undefined,
    };
    const runner = new PiRunner({ baseDir: 'C:\\tmp\\sdk-runner-test', runtime });
    const events: Array<{ eventType: string; text?: string }> = [];

    await expect(
      runner.run({ sessionId: 's1', message: 'current' }, (event) => events.push(event)),
    ).resolves.toMatchObject({ reply: 'sdk reply', attempts: 1 });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'text_delta', text: 'sdk' }),
        expect.objectContaining({ eventType: 'usage' }),
      ]),
    );
    await runner.close();
  });

  it('does not expose bash to read-only requests', async () => {
    const session: RuntimeSession = {
      sessionId: 'read-session',
      isStreaming: false,
      subscribe: () => () => undefined,
      prompt: async () => ({ text: 'read', sessionId: 'read-session', finalizationReason: 'completed' as const }),
      steer: async () => { throw new Error('not used'); },
      followUp: async () => { throw new Error('not used'); },
      abort: async () => undefined,
      compact: async () => undefined,
      dispose: () => undefined,
    };
    let allowedTools: string[] | undefined;
    const runtime: AgentRuntime = {
      kind: 'pi',
      createSession: async (options) => {
        allowedTools = options.allowedTools;
        return session;
      },
      close: async () => undefined,
    };
    const runner = new PiRunner({ baseDir: 'C:\\tmp\\read-only-runner-test', runtime });
    await runner.run({ sessionId: 'read-session', message: '查看状态', toolPolicy: 'read' });
    expect(allowedTools).toEqual([]);
    await runner.close();
  });

  it('assembles prompts, maps events and returns the final reply', async () => {
    const client = new FakeClient();
    const manager = new PiSessionManager({
      baseDir: 'C:\\tmp\\runner-test',
      ensureDirectories: false,
      createClient: () => client,
    });
    const runner = new PiRunner({ baseDir: 'C:\\tmp\\runner-test', sessionManager: manager });
    const events: Array<{ eventType: string; text?: string }> = [];
    const result = await runner.run(
      {
        sessionId: 's1',
        turnId: 't1',
        message: 'current',
        systemPrompt: 'system',
        history: [{ role: 'user', content: 'history' }],
      },
      (event) => events.push(event),
    );
    expect(result.reply).toBe('ok');
    expect(result.attempts).toBe(1);
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: 'text_delta', text: 'ok' })]),
    );
    expect(client.prompts[0]).toContain('[Current user message]\ncurrent');
    await runner.close();
  });

  it('recreates a failed session and retries within the queue limit', async () => {
    const clients: FakeClient[] = [];
    const manager = new PiSessionManager({
      baseDir: 'C:\\tmp\\runner-retry-test',
      ensureDirectories: false,
      createClient: () => {
        const client = new FakeClient(clients.length === 0);
        clients.push(client);
        return client;
      },
    });
    const runner = new PiRunner({
      baseDir: 'C:\\tmp\\runner-retry-test',
      sessionManager: manager,
      queueOptions: { maxAttempts: 2, retryDelay: async () => undefined },
    });
    await expect(runner.run({ sessionId: 's1', message: 'retry' })).resolves.toMatchObject({
      reply: 'ok',
      attempts: 2,
    });
    expect(clients).toHaveLength(2);
    expect(clients[0].closed).toBe(true);
    await runner.close();
  });
});
