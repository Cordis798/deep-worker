import { describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createApp, type App } from '../app.js';
import { initDatabase } from '../db/migration.js';
import { cookieRequest, cookieValue, jsonRequest } from '../helpers/test-app.js';

async function setupAdmin(app: App): Promise<string> {
  const response = await app.request(
    '/api/auth/setup',
    jsonRequest('/api/auth/setup', {
      username: 'admin',
      password: 'password123',
    }),
  );
  expect(response.status).toBe(201);
  return cookieValue(response);
}

async function registerMember(app: App): Promise<string> {
  const response = await app.request(
    '/api/auth/register',
    jsonRequest('/api/auth/register', {
      username: 'member',
      password: 'password123',
    }),
  );
  expect(response.status).toBe(201);
  return cookieValue(response);
}

async function createWorkspaceAndSession(
  app: App,
  cookie: string,
): Promise<{ jid: string; sessionId: string }> {
  const workspaceResponse = await app.request(
    '/api/workspaces',
    jsonRequest('/api/workspaces', { name: 'Runner test' }, cookie),
  );
  expect(workspaceResponse.status).toBe(201);
  const workspaceBody = (await workspaceResponse.json()) as {
    workspace: { jid: string };
  };

  const sessionResponse = await app.request(
    `/api/workspaces/${workspaceBody.workspace.jid}/runtime-sessions`,
    jsonRequest(
      `/api/workspaces/${workspaceBody.workspace.jid}/runtime-sessions`,
      { name: 'Runner session' },
      cookie,
    ),
  );
  expect(sessionResponse.status).toBe(201);
  const sessionBody = (await sessionResponse.json()) as {
    session: { id: string };
  };
  return {
    jid: workspaceBody.workspace.jid,
    sessionId: sessionBody.session.id,
  };
}

describe('Runner API', () => {
  it('runs a message through the fake runner and exposes durable events', async () => {
    const db = initDatabase(':memory:');
    const runner = new FakePiRunner({ response: 'hello from fake pi', emitBash: true });
    const app = createApp({ db, runner });
    const cookie = await setupAdmin(app);
    const { jid, sessionId } = await createWorkspaceAndSession(app, cookie);

    const response = await app.request(
      `/api/workspaces/${jid}/runtime-sessions/${sessionId}/messages`,
      jsonRequest(
        `/api/workspaces/${jid}/runtime-sessions/${sessionId}/messages`,
        { message: 'say hello', idempotency_key: 'runner-test-1' },
        cookie,
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      turn: { id: string; status: string; attempt: number };
      reply: string;
      events: Array<{ eventType: string }>;
    };
    expect(body.reply).toBe('hello from fake pi');
    expect(body.turn.status).toBe('completed');
    expect(body.turn.attempt).toBe(1);
    expect(body.events.map((event) => event.eventType)).toEqual([
      'init',
      'tool_use_start',
      'tool_result',
      'text_delta',
      'text_delta',
      'text_delta',
      'status',
    ]);
    expect(runner.calls).toHaveLength(1);

    const replay = await app.request(
      `/api/workspaces/${jid}/runtime-sessions/${sessionId}/messages`,
      jsonRequest(
        `/api/workspaces/${jid}/runtime-sessions/${sessionId}/messages`,
        { message: 'say hello again', idempotency_key: 'runner-test-1' },
        cookie,
      ),
    );
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { reply: string };
    expect(replayBody.reply).toBe('hello from fake pi');
    expect(runner.calls).toHaveLength(1);

    const read = await app.request(
      `/api/workspaces/${jid}/runtime-sessions/${sessionId}/turns/${body.turn.id}`,
      cookieRequest(cookie),
    );
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as {
      turn: { status: string };
      events: unknown[];
    };
    expect(readBody.turn.status).toBe('completed');
    expect(readBody.events).toHaveLength(7);
  });

  it('keeps runner messages isolated by workspace ownership', async () => {
    const db = initDatabase(':memory:');
    const runner = new FakePiRunner();
    const app = createApp({ db, runner });
    const adminCookie = await setupAdmin(app);
    const memberCookie = await registerMember(app);
    const { jid, sessionId } = await createWorkspaceAndSession(app, adminCookie);

    const response = await app.request(
      `/api/workspaces/${jid}/runtime-sessions/${sessionId}/messages`,
      jsonRequest(
        `/api/workspaces/${jid}/runtime-sessions/${sessionId}/messages`,
        { message: 'must not run' },
        memberCookie,
      ),
    );
    expect(response.status).toBe(404);
    expect(runner.calls).toHaveLength(0);
  });
});
