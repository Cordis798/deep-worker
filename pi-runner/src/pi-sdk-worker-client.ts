import { spawn, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import {
  encodeWorkerMessage,
  parseWorkerMessage,
  type WorkerRequest,
  type WorkerResponse,
} from './pi-sdk-worker-protocol.js';
import type {
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeInput,
  RuntimeResult,
  RuntimeSession,
  RuntimeSessionOptions,
} from './runtime.js';

interface WorkerProcessLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type WorkerSpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => WorkerProcessLike;

export interface PiSdkWorkerClientOptions {
  command: string;
  commandPrefixArgs?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runtimeOptions: RuntimeSessionOptions;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  killTimeoutMs?: number;
  spawnProcess?: WorkerSpawnProcess;
}

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const defaultSpawn: WorkerSpawnProcess = (command, args, options) =>
  spawn(command, args, options) as unknown as WorkerProcessLike;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sanitizeStderr(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|authorization|password|secret|token)\s*[:=]\s*\S+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-1_000);
}

/** 通过中性 JSON IPC 控制容器内的直接 Pi SDK Worker。 */
export class PiSdkWorkerClient implements RuntimeSession {
  private readonly options: Required<
    Pick<PiSdkWorkerClientOptions, 'requestTimeoutMs' | 'startupTimeoutMs' | 'killTimeoutMs'>
  > & PiSdkWorkerClientOptions;
  private readonly spawnProcess: WorkerSpawnProcess;
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private process: WorkerProcessLike | null = null;
  private requestCounter = 0;
  private buffer = '';
  private stderrTail = '';
  private processError: Error | null = null;
  private closing = false;
  private streaming = false;
  private resolvedSessionId: string;

  constructor(options: PiSdkWorkerClientOptions) {
    this.options = {
      requestTimeoutMs: 60_000,
      startupTimeoutMs: 30_000,
      killTimeoutMs: 1_000,
      ...options,
    };
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
    this.resolvedSessionId = options.runtimeOptions.sessionId;
  }

  get sessionId(): string {
    return this.resolvedSessionId;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('SDK worker is already started');
    this.processError = null;
    this.stderrTail = '';
    this.closing = false;
    let child: WorkerProcessLike;
    try {
      child = this.spawnProcess(this.options.command, this.options.commandPrefixArgs ?? [], {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw asError(error);
    }
    this.process = child;
    child.stdout.on('data', (chunk: Buffer | string) => this.pushOutput(chunk));
    child.stdout.on('end', () => this.pushOutputEnd());
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_000);
    });
    child.once('error', (error) => this.handleProcessError(error));
    child.once('exit', (code, signal) => this.handleExit(code, signal));
    const options = {
      ...this.options.runtimeOptions,
      provider: this.options.runtimeOptions.provider
        ? { ...this.options.runtimeOptions.provider, env: undefined }
        : undefined,
    };
    try {
      const response = await this.request(
        { type: 'initialize', id: this.nextId(), options },
        this.options.startupTimeoutMs,
      );
      if (response.type !== 'ready') {
        throw new Error('SDK worker did not become ready');
      }
      this.resolvedSessionId = response.sessionId;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async prompt(input: RuntimeInput): Promise<RuntimeResult> {
    return this.run('prompt', input.text);
  }

  async steer(input: RuntimeInput): Promise<RuntimeResult> {
    return this.run('steer', input.text);
  }

  async followUp(input: RuntimeInput): Promise<RuntimeResult> {
    return this.run('follow_up', input.text);
  }

  async abort(): Promise<void> {
    await this.expectOk({ type: 'abort', id: this.nextId() });
  }

  async compact(instructions?: string): Promise<void> {
    await this.expectOk({ type: 'compact', id: this.nextId(), instructions });
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.closing = true;
    this.rejectPending(new Error('SDK worker closed'));
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      child.once('exit', finish);
      try {
        child.stdin.end();
      } catch {
        // stdin may already be closed.
      }
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
      }
      setTimeout(() => {
        if (!finished) {
          try {
            child.kill('SIGKILL');
          } catch {
            // process has already exited
          }
          finish();
        }
      }, this.options.killTimeoutMs);
    });
    this.process = null;
    this.pending.clear();
    this.buffer = '';
  }

  dispose(): void {
    void this.close();
  }

  getStderrTail(): string {
    return sanitizeStderr(this.stderrTail);
  }

  private async run(type: 'prompt' | 'steer' | 'follow_up', text: string): Promise<RuntimeResult> {
    this.streaming = true;
    try {
      const response = await this.request({ type, id: this.nextId(), text });
      if (response.type !== 'result') throw new Error('SDK worker returned no result');
      return response.result;
    } finally {
      this.streaming = false;
    }
  }

  private async expectOk(request: WorkerRequest): Promise<void> {
    const response = await this.request(request);
    if (response.type !== 'ok') throw new Error('SDK worker command was not acknowledged');
  }

  private request(request: WorkerRequest, timeoutMs = this.options.requestTimeoutMs): Promise<WorkerResponse> {
    if (!this.process || this.closing) return Promise.reject(new Error('SDK worker is not running'));
    const id = 'id' in request ? request.id : undefined;
    if (!id) return Promise.reject(new Error('SDK worker request has no id'));
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SDK worker request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process!.stdin.write(encodeWorkerMessage(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  private nextId(): string {
    this.requestCounter += 1;
    return `worker-${this.requestCounter}`;
  }

  private pushOutput(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleResponse(line);
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > 1_048_576) {
      this.handleProcessError(new Error('SDK worker output frame is too large'));
    }
  }

  private pushOutputEnd(): void {
    if (this.buffer) this.handleResponse(`${this.buffer}\n`);
    this.buffer = '';
  }

  private handleResponse(line: string): void {
    let response: WorkerResponse;
    try {
      response = parseWorkerMessage(line) as WorkerResponse;
    } catch (error) {
      this.handleProcessError(asError(error));
      return;
    }
    if (response.type === 'event') {
      this.emit(response.event);
      return;
    }
    if (!('id' in response) || !response.id) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.type === 'error') pending.reject(new Error(response.message));
    else pending.resolve(response);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private handleProcessError(error: Error): void {
    if (this.processError) return;
    this.processError = error;
    this.rejectPending(error);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closing) return;
    const detail = this.getStderrTail();
    const suffix = detail ? `: ${detail}` : '';
    this.handleProcessError(
      this.processError ?? new Error(`SDK worker exited (${code ?? 'null'}/${signal ?? 'none'})${suffix}`),
    );
    this.process = null;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
