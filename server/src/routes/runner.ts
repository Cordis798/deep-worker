import crypto from 'node:crypto';
import type { NodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { authMiddleware } from '../middleware/auth.js';
import { formatZodError, createRunnerMessageSchema } from '../schemas.js';
import { getOwnedRuntimeSession } from '../runtime-sessions.js';
import {
  getRunnerTurnById,
  listRunnerOutbox,
  toRunnerTurnPublic,
} from '../runner-reliability.js';
import { RuntimeRunnerService } from '../runtime-runner-service.js';
import type { AppVariables } from '../types.js';

export function createRunnerRoutes(
  db: Database.Database,
  service: RuntimeRunnerService,
  upgradeWebSocket?: NodeWebSocket['upgradeWebSocket'],
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.post('/:jid/runtime-sessions/:sessionId/messages', async (c) => {
    const user = c.get('user')!;
    const jid = c.req.param('jid');
    const sessionId = c.req.param('sessionId');
    const session = getOwnedRuntimeSession(db, user.id, jid, sessionId);
    if (!session || session.status !== 'active') {
      return c.json({ error: 'Runtime session not found' }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = createRunnerMessageSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);
    try {
      const result = await service.submit({
        ownerUserId: user.id,
        workspaceJid: jid,
        sessionId,
        message: parsed.data.message,
        idempotencyKey: parsed.data.idempotency_key ?? `${user.id}:${crypto.randomUUID()}`,
        systemPrompt: parsed.data.system_prompt,
        outputContract: parsed.data.output_contract,
      });
      return c.json({
        turn: toRunnerTurnPublic(result.turn),
        reply: result.reply,
        events: result.events,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/idempotency key/i.test(message)) return c.json({ error: message }, 409);
      return c.json({ error: message }, 500);
    }
  });

  app.get('/:jid/runtime-sessions/:sessionId/turns/:turnId', (c) => {
    const user = c.get('user')!;
    const jid = c.req.param('jid');
    const sessionId = c.req.param('sessionId');
    const session = getOwnedRuntimeSession(db, user.id, jid, sessionId);
    if (!session) return c.json({ error: 'Runtime session not found' }, 404);
    const turn = getRunnerTurnById(db, c.req.param('turnId'));
    if (
      !turn ||
      turn.ownerUserId !== user.id ||
      turn.workspaceJid !== jid ||
      turn.sessionId !== sessionId
    ) {
      return c.json({ error: 'Turn not found' }, 404);
    }
    return c.json({ turn: toRunnerTurnPublic(turn), events: listRunnerOutbox(db, turn.id) });
  });

  if (upgradeWebSocket) {
    app.get(
      '/:jid/runtime-sessions/:sessionId/turns/:turnId/events',
      upgradeWebSocket((c) => {
        const user = c.get('user')!;
        const jid = c.req.param('jid') ?? '';
        const sessionId = c.req.param('sessionId') ?? '';
        const turnId = c.req.param('turnId') ?? '';
        const session = getOwnedRuntimeSession(db, user.id, jid, sessionId);
        const turn = getRunnerTurnById(db, turnId);
        const authorized =
          !!session &&
          !!turn &&
          turn.ownerUserId === user.id &&
          turn.workspaceJid === jid &&
          turn.sessionId === sessionId;
        let unsubscribe: (() => void) | undefined;
        return {
          onOpen: (_event, ws) => {
            if (!authorized) {
              ws.close(4404, 'Turn not found');
              return;
            }
            let live = false;
            const buffered: string[] = [];
            const send = (event: unknown) => {
              const encoded = JSON.stringify(event);
              if (live) ws.send(encoded);
              else buffered.push(encoded);
            };
            unsubscribe = service.streamHub.subscribe(sessionId, (event) => {
              if (event.turnId === turnId) send(event);
            });
            for (const event of listRunnerOutbox(db, turnId)) send(event.event);
            live = true;
            for (const event of buffered) ws.send(event);
            if (turn?.status === 'completed' || turn?.status === 'failed') {
              unsubscribe();
            }
          },
          onClose: () => {
            unsubscribe?.();
          },
        };
      }),
    );
  }

  return app;
}
