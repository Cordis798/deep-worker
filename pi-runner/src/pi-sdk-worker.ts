import { createInterface } from 'node:readline';
import { PiSdkRuntimeAdapter } from './pi-sdk-runtime.js';
import { encodeWorkerMessage, parseWorkerMessage, type WorkerRequest } from './pi-sdk-worker-protocol.js';
import type { RuntimeSession } from './runtime.js';

const runtime = new PiSdkRuntimeAdapter();
let session: RuntimeSession | undefined;
let unsubscribe: (() => void) | undefined;
let initialized = false;

function write(message: Parameters<typeof encodeWorkerMessage>[0]): void {
  process.stdout.write(encodeWorkerMessage(message));
}

async function handle(request: WorkerRequest): Promise<void> {
  if (request.type === 'initialize') {
    if (initialized) {
      write({ type: 'error', id: request.id, message: 'SDK worker is already initialized' });
      return;
    }
    try {
      session = await runtime.createSession({
        ...request.options,
        onContextStatus: undefined,
      });
      unsubscribe = session.subscribe((event) => write({ type: 'event', event }));
      initialized = true;
      write({ type: 'ready', id: request.id, sessionId: session.sessionId });
    } catch (error) {
      write({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (!session) {
    write({ type: 'error', id: request.id, message: 'SDK worker is not initialized' });
    return;
  }
  try {
    if (request.type === 'prompt' || request.type === 'steer' || request.type === 'follow_up') {
      const result = await session[
        request.type === 'prompt' ? 'prompt' : request.type === 'steer' ? 'steer' : 'followUp'
      ]({ text: request.text });
      write({ type: 'result', id: request.id, result });
    } else if (request.type === 'abort') {
      await session.abort();
      write({ type: 'ok', id: request.id });
    } else if (request.type === 'compact') {
      await session.compact(request.instructions);
      write({ type: 'ok', id: request.id });
    } else if (request.type === 'close') {
      unsubscribe?.();
      session.dispose();
      await runtime.close();
      write({ type: 'ok', id: request.id });
      process.exitCode = 0;
    }
  } catch (error) {
    write({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  try {
    const request = parseWorkerMessage(`${line}\n`) as WorkerRequest;
    void handle(request);
  } catch (error) {
    write({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});

process.on('SIGTERM', () => {
  unsubscribe?.();
  session?.dispose();
  void runtime.close().finally(() => process.exit(0));
});
