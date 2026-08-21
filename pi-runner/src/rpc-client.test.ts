import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { RpcProcessLike } from './rpc-client.js';
import { PiRpcClient } from './rpc-client.js';

class MockProcess extends EventEmitter implements RpcProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  promptCount = 0;
  abortCount = 0;
  private inputBuffer = '';
  private readonly responseDelayMs: number;

  constructor(responseDelayMs = 0) {
    super();
    this.responseDelayMs = responseDelayMs;
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.inputBuffer += chunk.toString();
      while (true) {
        const newline = this.inputBuffer.indexOf('\n');
        if (newline < 0) return;
        const line = this.inputBuffer.slice(0, newline).replace(/\r$/, '');
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        this.handle(JSON.parse(line) as { id: string; type: string });
      }
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signalCode = signal ?? 'SIGTERM';
    this.exitCode = null;
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('exit', null, this.signalCode));
    return true;
  }

  fail(code: number, stderr: string): void {
    this.stderr.write(stderr);
    this.stderr.end();
    this.exitCode = code;
    queueMicrotask(() => this.emit('exit', code, null));
  }

  private write(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  private handle(command: { id: string; type: string }): void {
    const response = () => {
      switch (command.type) {
        case 'get_state':
          this.write({
            id: command.id,
            type: 'response',
            command: 'get_state',
            success: true,
            data: {
              sessionId: 'fake-session',
              isStreaming: false,
              messageCount: 0,
            },
          });
          return;
        case 'bash':
          this.write({
            id: command.id,
            type: 'response',
            command: 'bash',
            success: true,
            data: { output: 'fake bash\n', exitCode: 0, cancelled: false },
          });
          return;
        case 'abort':
          this.abortCount += 1;
          this.write({
            id: command.id,
            type: 'response',
            command: 'abort',
            success: true,
          });
          return;
        case 'prompt':
          this.promptCount += 1;
          this.write({
            id: command.id,
            type: 'response',
            command: 'prompt',
            success: true,
          });
          const finishPrompt = () => {
            this.write({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
            });
            this.write({
              type: 'message_end',
              message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
            });
            this.write({ type: 'agent_settled' });
          };
          if (this.responseDelayMs > 0) setTimeout(finishPrompt, this.responseDelayMs);
          else finishPrompt();
          return;
        default:
          this.write({
            id: command.id,
            type: 'response',
            command: command.type,
            success: true,
          });
      }
    };
    if (this.responseDelayMs > 0 && command.type !== 'prompt' && command.type !== 'abort') {
      setTimeout(response, this.responseDelayMs);
    } else response();
  }
}

const processes: MockProcess[] = [];

afterEach(() => {
  for (const process of processes.splice(0)) process.kill('SIGTERM');
});

function makeClient(options: { responseDelayMs?: number; requestTimeoutMs?: number } = {}) {
  const process = new MockProcess(options.responseDelayMs);
  processes.push(process);
  const client = new PiRpcClient({
    command: 'fake-pi',
    cwd: 'C:\\workspace',
    noSession: true,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
    spawnProcess: () => process,
  });
  return { client, process };
}

describe('PiRpcClient', () => {
  it('starts, sends commands, streams until agent_settled, and closes', async () => {
    const { client, process } = makeClient();
    await client.start();
    await expect(client.getState()).resolves.toMatchObject({ sessionId: 'fake-session' });
    await expect(client.bash('echo hi')).resolves.toMatchObject({ output: 'fake bash\n' });
    const result = await client.promptAndWait('hello', { timeoutMs: 100 });
    expect(result.map((event) => event.type)).toEqual([
      'message_update',
      'message_end',
      'agent_settled',
    ]);
    expect(process.promptCount).toBe(1);
    await client.close();
    expect(client.isStarted()).toBe(false);
  });

  it('aborts an in-flight operation when the settle timeout expires', async () => {
    const { client, process } = makeClient({ responseDelayMs: 1_000 });
    await client.start();
    await expect(client.promptAndWait('slow', { timeoutMs: 5 })).rejects.toThrow(/timed out/i);
    expect(process.abortCount).toBeGreaterThanOrEqual(1);
    await client.close();
  });

  it('rejects a request when the response timeout expires', async () => {
    const { client } = makeClient({ responseDelayMs: 100 });
    await client.start();
    await expect(client.getState()).rejects.toThrow(/timed out/i);
    await client.close();
  });

  it('在进程退出错误中保留脱敏后的 stderr 诊断', async () => {
    const { client, process } = makeClient();
    const started = client.start();
    process.fail(125, 'failed to connect to the docker API\napi_key=should-not-leak\n');

    await expect(started).rejects.toThrow(
      'Pi RPC process exited (code=125, signal=null): failed to connect to the docker API api_key=[REDACTED]',
    );
  });

  it('将包装命令参数放在 Pi RPC 参数之前', async () => {
    const process = new MockProcess();
    processes.push(process);
    let spawnedArgs: string[] = [];
    const client = new PiRpcClient({
      command: 'docker',
      commandPrefixArgs: ['run', '--rm', 'deep-worker-pi:latest', 'pi'],
      cwd: 'C:\\workspace',
      noSession: true,
      startupTimeoutMs: 1,
      spawnProcess: (_command, args) => {
        spawnedArgs = args;
        return process;
      },
    });

    await client.start();

    expect(spawnedArgs).toEqual([
      'run',
      '--rm',
      'deep-worker-pi:latest',
      'pi',
      '--mode',
      'rpc',
      '--no-session',
      '--tools',
      'bash',
    ]);
    await client.close();
  });
});
