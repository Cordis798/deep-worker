import { describe, expect, it } from 'vitest';
import { encodeWorkerMessage, parseWorkerMessage } from './pi-sdk-worker-protocol.js';

describe('SDK worker protocol', () => {
  it('round-trips one framed JSON message without changing payloads', () => {
    const payload = { type: 'prompt', id: 'request-1', text: 'hello' } as const;
    expect(parseWorkerMessage(encodeWorkerMessage(payload))).toEqual(payload);
  });

  it('rejects malformed or oversized frames', () => {
    expect(() => parseWorkerMessage('{"type":"prompt"}\nextra')).toThrow(
      'SDK worker message must be one JSON line',
    );
    expect(() => parseWorkerMessage(`${'x'.repeat(1_048_577)}\n`)).toThrow(
      'SDK worker message is too large',
    );
  });
});
