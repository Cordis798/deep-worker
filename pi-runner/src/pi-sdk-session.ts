import {
  resultFromAssistantMessage,
  type RuntimeEvent,
  type RuntimeEventListener,
  type RuntimeInput,
  type RuntimeResult,
  type RuntimeSession,
} from './runtime.js';

export interface PiAgentSessionLike {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly messages: unknown[];
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  dispose(): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class PiSdkRuntimeSession implements RuntimeSession {
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly unsubscribe: () => void;
  private readonly settledWaiters = new Set<() => void>();
  private settledVersion = 0;
  private disposed = false;

  constructor(
    private readonly session: PiAgentSessionLike,
    private readonly disposeHook?: () => Promise<void> | void,
  ) {
    this.unsubscribe = session.subscribe((event) => this.onSdkEvent(event));
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(input: RuntimeInput): Promise<RuntimeResult> {
    return this.invoke(() => this.session.prompt(input.text));
  }

  steer(input: RuntimeInput): Promise<RuntimeResult> {
    return this.invoke(() => this.session.steer(input.text));
  }

  followUp(input: RuntimeInput): Promise<RuntimeResult> {
    return this.invoke(() => this.session.followUp(input.text));
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  compact(instructions?: string): Promise<void> {
    return this.session.compact(instructions);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.session.dispose();
    await this.disposeHook?.();
    this.listeners.clear();
    for (const resolve of this.settledWaiters) resolve();
    this.settledWaiters.clear();
  }

  private async invoke(action: () => Promise<void>): Promise<RuntimeResult> {
    if (this.disposed) throw new Error('Pi SDK session is disposed');
    const before = this.settledVersion;
    await action();
    if (this.session.isStreaming && this.settledVersion === before) {
      await new Promise<void>((resolve) => this.settledWaiters.add(resolve));
    }
    const assistant = [...this.session.messages]
      .reverse()
      .find((message) => record(message)?.role === 'assistant');
    if (!assistant) throw new Error('Pi SDK completed without an assistant message');
    const result = resultFromAssistantMessage(assistant, this.sessionId);
    this.emit({ type: 'result', sessionId: this.sessionId, result });
    return result;
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private onSdkEvent(event: Record<string, unknown>): void {
    const type = string(event.type);
    if (type === 'agent_settled') {
      this.settledVersion += 1;
      this.emit({ type: 'status', sessionId: this.sessionId, statusText: 'agent settled' });
      for (const resolve of this.settledWaiters) resolve();
      this.settledWaiters.clear();
      return;
    }
    if (type === 'message_update') {
      const update = record(event.assistantMessageEvent);
      const updateType = string(update?.type);
      if (updateType === 'text_delta' || updateType === 'thinking_delta') {
        this.emit({
          type: updateType,
          sessionId: this.sessionId,
          delta: string(update?.delta) ?? '',
        });
        return;
      }
      if (updateType === 'toolcall_start' || updateType === 'toolcall_end') {
        const call = record(update?.toolCall) ?? update ?? {};
        this.emit({
          type: updateType === 'toolcall_start' ? 'tool_start' : 'tool_end',
          sessionId: this.sessionId,
          toolName: string(call.name) ?? string(call.toolName) ?? 'unknown',
          toolCallId: string(call.id) ?? 'unknown',
          input: call.arguments ?? call.args,
        });
        return;
      }
    }
    if (
      type === 'tool_execution_start' ||
      type === 'tool_execution_update' ||
      type === 'tool_execution_end'
    ) {
      this.emit({
        type:
          type === 'tool_execution_start'
            ? 'tool_start'
            : type === 'tool_execution_update'
              ? 'tool_update'
              : 'tool_end',
        sessionId: this.sessionId,
        toolName: string(event.toolName) ?? 'unknown',
        toolCallId: string(event.toolCallId) ?? 'unknown',
        input: event.args,
        result: event.partialResult ?? event.result,
        isError: event.isError === true,
      });
    }
  }
}
