import type { RuntimeEvent, RuntimeResult, RuntimeSessionOptions } from './runtime.js';

export type WorkerRequest =
  | { type: 'initialize'; id: string; options: RuntimeSessionOptions }
  | { type: 'prompt' | 'steer' | 'follow_up'; id: string; text: string }
  | { type: 'abort' | 'compact' | 'close'; id: string; instructions?: string };

export type WorkerResponse =
  | { type: 'ready'; id: string; sessionId: string }
  | { type: 'event'; event: RuntimeEvent }
  | { type: 'result'; id: string; result: RuntimeResult }
  | { type: 'ok'; id: string }
  | { type: 'error'; id?: string; message: string };

const MAX_FRAME_BYTES = 1_048_576;

export function encodeWorkerMessage(message: WorkerRequest | WorkerResponse): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseWorkerMessage(line: string): WorkerRequest | WorkerResponse {
  const withoutNewline = line.endsWith('\n') ? line.slice(0, -1) : line;
  if (Buffer.byteLength(withoutNewline, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error('SDK worker message is too large');
  }
  if (withoutNewline.includes('\n') || withoutNewline.includes('\r')) {
    throw new Error('SDK worker message must be one JSON line');
  }
  try {
    const parsed: unknown = JSON.parse(withoutNewline);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as WorkerRequest | WorkerResponse;
  } catch {
    throw new Error('SDK worker message is invalid JSON');
  }
}
