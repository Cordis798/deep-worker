import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createApp, type App } from '../app.js';
import { initDatabase } from '../db/migration.js';
import { startServer } from '../server.js';
import { createRunnerSubmission } from '../runner-reliability.js';
import { RuntimeRunnerService } from '../runtime-runner-service.js';
import { cookieValue, jsonRequest } from '../helpers/test-app.js';

async function setupAdmin(app: App): Promise<{ cookie: string; userId: string }> {
  const setup = await app.request(
    '/api/auth/setup',
    jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }),
  );
  expect(setup.status).toBe(201);
  const cookie = cookieValue(setup);
  const me = await app.request('/api/auth/me', {
    method: 'GET',
    headers: { cookie: `dw_session=${cookie}` },
  });
  const body = (await me.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

async function createWorkspaceAndSession(
  app: App,
  cookie: string,
): Promise<{ jid: string; sessionId: string }> {
  const workspace = await app.request(
    '/api/workspaces',
    jsonRequest('/api/workspaces', { name: 'WebSocket test' }, cookie),
  );
  const workspaceBody = (await workspace.json()) as { workspace: { jid: string } };
  const session = await app.request(
    `/api/workspaces/${workspaceBody.workspace.jid}/runtime-sessions`,
    jsonRequest(
      `/api/workspaces/${workspaceBody.workspace.jid}/runtime-sessions`,
      { name: 'WebSocket session' },
      cookie,
    ),
  );
  const sessionBody = (await session.json()) as { session: { id: string } };
  return { jid: workspaceBody.workspace.jid, sessionId: sessionBody.session.id };
}

describe('Runner WebSocket forwarding', () => {
  it('forwards Fake Pi StreamEvents to an authenticated socket', async () => {
    const db = initDatabase(':memory:');
    const runner = new FakePiRunner({ response: 'socket reply', delayMs: 5, emitBash: true });
    const service = new RuntimeRunnerService({ db, runner, retryBaseMs: 0 });
    const app = createApp({ db, runnerService: service });
    const { cookie, userId } = await setupAdmin(app);
    const { jid, sessionId } = await createWorkspaceAndSession(app, cookie);
    const submission = createRunnerSubmission(db, {
      ownerUserId: userId,
      workspaceJid: jid,
      sessionId,
      message: 'stream this',
      idempotencyKey: 'socket-message-1',
    });
    const handle = await startServer({ app, port: 0, host: '127.0.0.1' });
    app.injectWebSocket(handle.server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${handle.port}/api/workspaces/${encodeURIComponent(jid)}/runtime-sessions/${sessionId}/turns/${submission.turn.id}/events`,
      { headers: { cookie: `dw_session=${cookie}` } },
    );
    const events: Array<{ eventType: string; text?: string }> = [];
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => {
          void service
            .submit({
              ownerUserId: userId,
              workspaceJid: jid,
              sessionId,
              message: 'ignored because inbox is durable',
              idempotencyKey: 'socket-message-1',
            })
            .catch(reject);
        });
        socket.on('message', (data) => {
          const event = JSON.parse(data.toString()) as { eventType: string; text?: string };
          events.push(event);
          if (event.eventType === 'status') resolve();
        });
        socket.on('error', reject);
      });
      expect(events.map((event) => event.eventType)).toEqual([
        'init',
        'tool_use_start',
        'tool_result',
        'text_delta',
        'text_delta',
        'status',
      ]);
      expect(
        events
          .filter((event) => event.eventType === 'text_delta')
          .map((event) => event.text ?? '')
          .join(''),
      ).toBe('socket reply');
    } finally {
      socket.close();
      await handle.close();
      await app.close();
    }
  });
});
