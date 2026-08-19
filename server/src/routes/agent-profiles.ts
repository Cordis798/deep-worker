import { Hono } from 'hono';
import {
  createAgentProfile,
  deleteAgentProfile,
  getOwnedAgentProfile,
  listOwnedAgentProfiles,
  listPromptVersions,
  restorePromptVersion,
  toAgentProfilePublic,
  updateAgentProfile,
} from '../agent-profiles.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  createAgentProfileSchema,
  formatZodError,
  updateAgentProfileSchema,
} from '../schemas.js';
import type { Db } from '../agent-profiles.js';
import type { AppVariables } from '../types.js';

export function createAgentProfileRoutes(db: Db) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.get('/', (c) => {
    const user = c.get('user')!;
    return c.json({
      agent_profiles: listOwnedAgentProfiles(db, user.id).map(toAgentProfilePublic),
    });
  });

  app.post('/', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = createAgentProfileSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }
    const row = createAgentProfile(db, user.id, {
      name: parsed.data.name,
      identity_prompt: parsed.data.identity_prompt,
      soul_prompt: parsed.data.soul_prompt,
      agents_prompt: parsed.data.agents_prompt,
      tools_prompt: parsed.data.tools_prompt,
      prompt_mode: parsed.data.prompt_mode,
    }, { isDefault: parsed.data.is_default });
    return c.json({ agent_profile: toAgentProfilePublic(row) }, 201);
  });

  app.get('/:id', (c) => {
    const user = c.get('user')!;
    const row = getOwnedAgentProfile(db, user.id, c.req.param('id'));
    if (!row) return c.json({ error: 'Agent profile not found' }, 404);
    return c.json({ agent_profile: toAgentProfilePublic(row) });
  });

  app.patch('/:id', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateAgentProfileSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }
    const result = updateAgentProfile(db, user.id, c.req.param('id'), parsed.data);
    if (!result.ok) {
      if (result.reason === 'archived') {
        return c.json({ error: 'Agent profile is archived' }, 409);
      }
      return c.json({ error: 'Agent profile not found' }, 404);
    }
    const row = getOwnedAgentProfile(db, user.id, c.req.param('id'))!;
    return c.json({ agent_profile: toAgentProfilePublic(row) });
  });

  app.delete('/:id', (c) => {
    const user = c.get('user')!;
    const result = deleteAgentProfile(db, user.id, c.req.param('id'));
    if (!result.ok) {
      if (result.reason === 'is_default') {
        return c.json({ error: '不能删除内置的 HappyClaw 智能体' }, 400);
      }
      if (result.reason === 'has_workspaces') {
        return c.json(
          { error: 'Agent profile still has workspaces; migrate them first' },
          409,
        );
      }
      return c.json({ error: 'Agent profile not found' }, 404);
    }
    return c.json({ success: true });
  });

  app.get('/:id/prompt-versions', (c) => {
    const user = c.get('user')!;
    const versions = listPromptVersions(db, user.id, c.req.param('id'));
    if (!versions) return c.json({ error: 'Agent profile not found' }, 404);
    return c.json({ versions });
  });

  app.post('/:id/prompt-versions/:version/restore', (c) => {
    const user = c.get('user')!;
    const version = Number(c.req.param('version'));
    if (!Number.isInteger(version) || version < 1) {
      return c.json({ error: 'Invalid version' }, 400);
    }
    const result = restorePromptVersion(
      db,
      user.id,
      c.req.param('id'),
      version,
    );
    if (!result.ok) {
      if (result.reason === 'archived') {
        return c.json({ error: 'Agent profile is archived' }, 409);
      }
      if (result.reason === 'version_not_found') {
        return c.json({ error: 'Version not found' }, 404);
      }
      return c.json({ error: 'Agent profile not found' }, 404);
    }
    const row = getOwnedAgentProfile(db, user.id, c.req.param('id'))!;
    return c.json({ agent_profile: toAgentProfilePublic(row) });
  });

  return app;
}
