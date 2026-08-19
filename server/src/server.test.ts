import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { startServer } from './server.js';

describe('server', () => {
  it('starts and serves /healthz over HTTP', async () => {
    const app = createApp();
    const handle = await startServer({ app, port: 0, host: '127.0.0.1' });
    try {
      const response = await fetch(
        `http://127.0.0.1:${handle.port}/healthz`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
    } finally {
      await handle.close();
    }
  });

  it('rejects when the port is already in use', async () => {
    const app = createApp();
    const first = await startServer({ app, port: 0, host: '127.0.0.1' });
    try {
      await expect(
        startServer({ app, port: first.port, host: '127.0.0.1' }),
      ).rejects.toThrow();
    } finally {
      await first.close();
    }
  });
});
