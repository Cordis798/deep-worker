import { describe, expect, it, vi } from 'vitest';
import { PiSdkRuntimeSession, type PiAgentSessionLike } from './pi-sdk-session.js';

class FakeAgentSession implements PiAgentSessionLike {
  readonly sessionId = 'sdk-session';
  isStreaming = false;
  messages: unknown[] = [];
  private listener?: (event: Record<string, unknown>) => void;
  readonly dispose = vi.fn();
  readonly abort = vi.fn(async () => undefined);
  readonly compact = vi.fn(async () => undefined);

  subscribe(listener: (event: Record<string, unknown>) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async prompt(): Promise<void> {
    this.isStreaming = true;
    this.listener?.({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });
    this.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      stopReason: 'stop',
      usage: { input: 2, output: 1 },
    });
    this.isStreaming = false;
    this.listener?.({ type: 'agent_settled' });
  }

  async steer(): Promise<void> {
    await this.prompt();
  }

  async followUp(): Promise<void> {
    await this.prompt();
  }
}

describe('PiSdkRuntimeSession', () => {
  it('subscribes before prompting and returns one terminal result', async () => {
    const sdk = new FakeAgentSession();
    const session = new PiSdkRuntimeSession(sdk);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));

    await expect(session.prompt({ text: 'hi' })).resolves.toMatchObject({
      text: 'hello',
      sessionId: 'sdk-session',
      finalizationReason: 'completed',
    });
    expect(events).toContainEqual({
      type: 'text_delta',
      sessionId: 'sdk-session',
      delta: 'hello',
    });
    expect(events.filter((event) => (event as { type: string }).type === 'result')).toHaveLength(1);
  });

  it('disposes SDK resources idempotently', () => {
    const sdk = new FakeAgentSession();
    const session = new PiSdkRuntimeSession(sdk);
    session.dispose();
    session.dispose();
    expect(sdk.dispose).toHaveBeenCalledTimes(1);
  });
});
