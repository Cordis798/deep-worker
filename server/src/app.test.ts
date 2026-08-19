import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('app', () => {
  it('serves /healthz with 200 and status ok', async () => {
    const app = createApp();
    const response = await app.request('/healthz');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
  });
});
