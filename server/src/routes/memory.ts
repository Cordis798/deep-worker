import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import {
  createWorkspaceMemory,
  forgetWorkspaceMemory,
  getWorkspaceMemory,
  getWorkspaceMemoryRevisions,
  listWorkspaceMemories,
  MemoryServiceError,
  searchWorkspaceMemories,
  updateWorkspaceMemory,
} from '../memory-service.js';
import type { Db } from '../workspaces.js';
import type { AppVariables } from '../types.js';

function handleError(error: unknown) {
  if (error instanceof MemoryServiceError) {
    return { body: { error: error.message, code: error.code, current: error.current }, status: error.code === 'revision_conflict' ? 409 : error.code === 'not_found' ? 404 : 400 } as const;
  }
  return { body: { error: error instanceof Error ? error.message : '记忆操作失败' }, status: 400 } as const;
}

export function createMemoryRoutes(db: Db) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.get('/:jid/memory/search', (c) => {
    try {
      const memories = searchWorkspaceMemories(db, c.get('user')!.id, c.req.param('jid'), c.req.query('q') ?? '', c.req.query('kind') as never);
      return c.json({ memories });
    } catch (error) {
      const result = handleError(error); return c.json(result.body, result.status);
    }
  });

  app.get('/:jid/memory', (c) => {
    try {
      const memories = listWorkspaceMemories(db, c.get('user')!.id, c.req.param('jid'), c.req.query('kind') as never);
      return c.json({ memories });
    } catch (error) {
      const result = handleError(error); return c.json(result.body, result.status);
    }
  });

  app.post('/:jid/memory', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const memory = createWorkspaceMemory(db, {
        ownerUserId: c.get('user')!.id,
        workspaceJid: c.req.param('jid'),
        kind: body.kind as never,
        title: typeof body.title === 'string' ? body.title : undefined,
        content: typeof body.content === 'string' ? body.content : '',
        source: typeof body.source === 'string' ? body.source : undefined,
      });
      return c.json({ memory }, 201);
    } catch (error) {
      const result = handleError(error); return c.json(result.body, result.status);
    }
  });

  app.get('/:jid/memory/:memoryId/revisions', (c) => {
    try {
      return c.json({ revisions: getWorkspaceMemoryRevisions(db, c.get('user')!.id, c.req.param('jid'), c.req.param('memoryId')) });
    } catch (error) {
      const result = handleError(error); return c.json(result.body, result.status);
    }
  });

  app.get('/:jid/memory/:memoryId', (c) => {
    try {
      return c.json({ memory: getWorkspaceMemory(db, c.get('user')!.id, c.req.param('jid'), c.req.param('memoryId')) });
    } catch (error) {
      const result = handleError(error); return c.json(result.body, result.status);
    }
  });

  app.patch('/:jid/memory/:memoryId', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const patch: Record<string, never> = {};
      for (const key of ['kind', 'title', 'content', 'source'] as const) {
        if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
      }
      const memory = updateWorkspaceMemory(db, {
        ownerUserId: c.get('user')!.id,
        workspaceJid: c.req.param('jid'),
        memoryId: c.req.param('memoryId'),
        expectedRevision: Number(body.expected_revision),
        patch: patch as never,
      });
      return c.json({ memory });
    } catch (error) {
      const result = handleError(error); return c.json(result.body, result.status);
    }
  });

  app.delete('/:jid/memory/:memoryId', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { expected_revision?: unknown };
      forgetWorkspaceMemory(db, {
        ownerUserId: c.get('user')!.id,
        workspaceJid: c.req.param('jid'),
        memoryId: c.req.param('memoryId'),
        expectedRevision: Number(body.expected_revision),
      });
      return c.json({ success: true });
    } catch (error) {
      const result = handleError(error); return c.json(result.body, result.status);
    }
  });

  return app;
}
