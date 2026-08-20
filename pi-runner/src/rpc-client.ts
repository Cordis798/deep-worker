import { spawn, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { JsonlDecoder, serializeJsonLine } from './jsonl.js';
import type {
  RpcBashResult,
  RpcCommand,
  RpcEvent,
  RpcResponse,
  RpcSessionState,
} from './rpc-types.js';

export interface RpcProcessLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type RpcSpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => RpcProcessLike;

export interface PiRpcClientOptions {
  command?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sessionDir?: string;
  sessionFile?: string;
  noSession?: boolean;
  tools?: string[];
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  killTimeoutMs?: number;
  spawnProcess?: RpcSpawnProcess;
}

export interface PromptAndWaitOptions {
  timeoutMs?: number;
  streamingBehavior?: 'steer' | 'followUp';
  onEvent?: (event: RpcEvent) => void;
}

type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RpcCommandBody = RpcCommand extends infer Command
  ? Command extends { id?: string }
    ? Omit<Command, 'id'>
    : never
  : never;

const defaultSpawn: RpcSpawnProcess = (command, args, options) =>
  spawn(command, args, options) as unknown as RpcProcessLike;

function defaultCommand(): string {
  return process.platform === 'win32' ? 'pi.cmd' : 'pi';
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class PiRpcClient {
  private readonly options: Required<Pick<PiRpcClientOptions, 'requestTimeoutMs' | 'startupTimeoutMs' | 'killTimeoutMs'>> & PiRpcClientOptions;
  private readonly spawnProcess: RpcSpawnProcess;
  private process: RpcProcessLike | null = null;
  private decoder = new JsonlDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: RpcEvent) => void>();
  private requestCounter = 0;
  private stderrTail = '';
  private processError: Error | null = null;
  private closing = false;

  constructor(options: PiRpcClientOptions) {
    this.options = {
      requestTimeoutMs: 30_000,
      startupTimeoutMs: 250,
      killTimeoutMs: 1_000,
      ...options,
    };
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('Pi RPC client is already started');
    this.processError = null;
    this.closing = false;
    const args = this.buildArgs();
    let child: RpcProcessLike;
    try {
      child = this.spawnProcess(this.options.command ?? defaultCommand(), args, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw asError(error);
    }
    this.process = child;
    child.stdout.on('data', (chunk: Buffer | string) => {
      for (const line of this.decoder.push(chunk)) this.handleLine(line);
    });
    child.stdout.on('end', () => {
      for (const line of this.decoder.end()) this.handleLine(line);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_000);
    });
    child.once('error', (error) => this.handleProcessError(error));
    child.once('exit', (code, signal) => this.handleExit(code, signal));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        if (this.processError) reject(this.processError);
        else resolve();
      }, this.options.startupTimeoutMs);
      const cleanup = () => clearTimeout(timer);
      if (child.exitCode !== null) {
        cleanup();
        reject(this.processError ?? this.exitError(child.exitCode, child.signalCode));
      }
    });
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.closing = true;
    this.rejectPending(new Error('Pi RPC client closed'));
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
        // The process may already have closed its stdin.
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
            // Nothing else to clean up.
          }
          finish();
        }
      }, this.options.killTimeoutMs);
    });
    this.process = null;
    this.pending.clear();
    this.decoder = new JsonlDecoder();
  }

  isStarted(): boolean {
    return this.process !== null;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  async prompt(message: string, options: Pick<PromptAndWaitOptions, 'streamingBehavior'> = {}): Promise<void> {
    await this.send({ type: 'prompt', message, streamingBehavior: options.streamingBehavior });
  }

  async promptAndWait(message: string, options: PromptAndWaitOptions = {}): Promise<RpcEvent[]> {
    const events: RpcEvent[] = [];
    let unsubscribe: () => void = () => undefined;
    const settled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error('Pi RPC prompt timed out waiting for agent_settled'));
      }, options.timeoutMs ?? 60_000);
      unsubscribe = this.onEvent((event) => {
        events.push(event);
        options.onEvent?.(event);
        if (event.type === 'agent_settled') {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
    void settled.catch(() => undefined);
    try {
      await this.prompt(message, options);
      await settled;
      return events;
    } catch (error) {
      unsubscribe();
      void this.abort().catch(() => undefined);
      throw asError(error);
    }
  }

  async abort(): Promise<void> {
    await this.send({ type: 'abort' });
  }

  async bash(command: string): Promise<RpcBashResult> {
    return this.getData<RpcBashResult>(await this.send({ type: 'bash', command }));
  }

  async getState(): Promise<RpcSessionState> {
    return this.getData<RpcSessionState>(await this.send({ type: 'get_state' }));
  }

  async setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
    return this.getData<Record<string, unknown>>(
      await this.send({ type: 'set_model', provider, modelId }),
    );
  }

  async getLastAssistantText(): Promise<string | null> {
    return this.getData<{ text: string | null }>(
      await this.send({ type: 'get_last_assistant_text' }),
    ).text;
  }

  private buildArgs(): string[] {
    const args = ['--mode', 'rpc'];
    if (this.options.noSession) args.push('--no-session');
    else if (this.options.sessionFile) args.push('--session', this.options.sessionFile);
    else if (this.options.sessionDir) args.push('--session-dir', this.options.sessionDir);
    args.push('--tools', (this.options.tools ?? ['bash']).join(','));
    args.push(...(this.options.args ?? []));
    return args;
  }

  private async send(command: RpcCommandBody): Promise<RpcResponse> {
    const child = this.process;
    if (!child || !child.stdin.writable) throw this.processError ?? new Error('Pi RPC client is not started');
    if (this.processError) throw this.processError;
    const id = `req_${++this.requestCounter}`;
    const fullCommand = { ...command, id };
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC request ${command.type} timed out`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(serializeJsonLine(fullCommand));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    }).then((response) => {
      if (!response.success) throw new Error(response.error ?? `Pi RPC ${command.type} failed`);
      return response;
    });
  }

  private handleLine(line: string): void {
    if (!line) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (pending) {
        this.pending.delete(record.id);
        clearTimeout(pending.timer);
        pending.resolve(record as unknown as RpcResponse);
        return;
      }
    }
    if (typeof record.type === 'string') {
      for (const listener of this.listeners) listener(record as RpcEvent);
    }
  }

  private handleProcessError(error: Error): void {
    this.processError = new Error(`Pi RPC process error: ${error.message}`);
    this.rejectPending(this.processError);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.closing) {
      this.processError = this.exitError(code, signal);
      this.rejectPending(this.processError);
    }
  }

  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    return new Error(`Pi RPC process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private getData<T>(response: RpcResponse): T {
    return response.data as T;
  }
}

export type { RpcBashResult, RpcCommand, RpcEvent, RpcResponse, RpcSessionState } from './rpc-types.js';
