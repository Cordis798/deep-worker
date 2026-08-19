import { Hono } from 'hono';
import {
  createChannelAccount,
  deleteChannelAccount,
  getOwnedChannelAccount,
  listOwnedChannelAccounts,
  toChannelAccountPublic,
  updateChannelAccount,
} from '../channel-accounts.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  createChannelAccountSchema,
  formatZodError,
  updateChannelAccountSchema,
} from '../schemas.js';
import type { Db } from '../channel-accounts.js';
import type { AppVariables } from '../types.js';

export function createChannelAccountRoutes(db: Db) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.get('/', (c) => {
    const user = c.get('user')!;
    return c.json({
      channel_accounts: listOwnedChannelAccounts(db, user.id).map(
        toChannelAccountPublic,
      ),
    });
  });

  app.post('/', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = createChannelAccountSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }
    const result = createChannelAccount(db, user.id, {
      provider: parsed.data.provider,
      name: parsed.data.name,
      is_default: parsed.data.is_default,
      default_workspace_jid: parsed.data.default_workspace_jid,
    });
    if (!result.ok) {
      if (result.reason === 'invalid_provider') {
        return c.json({ error: 'Unsupported provider' }, 400);
      }
      if (result.reason === 'invalid_workspace') {
        return c.json({ error: 'Default workspace not found' }, 400);
      }
      if (result.reason === 'duplicate') {
        return c.json({ error: 'Channel account with this name already exists' }, 409);
      }
      return c.json({ error: 'Failed to create channel account' }, 400);
    }
    const row = listOwnedChannelAccounts(db, user.id).find(
      (a) => a.name === parsed.data.name && a.provider === parsed.data.provider,
    )!;
    return c.json({ channel_account: toChannelAccountPublic(row) }, 201);
  });

  app.get('/:id', (c) => {
    const user = c.get('user')!;
    const row = getOwnedChannelAccount(db, user.id, c.req.param('id'));
    if (!row) return c.json({ error: 'Channel account not found' }, 404);
    return c.json({ channel_account: toChannelAccountPublic(row) });
  });

  app.patch('/:id', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateChannelAccountSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }
    const result = updateChannelAccount(db, user.id, c.req.param('id'), parsed.data);
    if (!result.ok) {
      if (result.reason === 'invalid_workspace') {
        return c.json({ error: 'Default workspace not found' }, 400);
      }
      return c.json({ error: 'Channel account not found' }, 404);
    }
    const row = getOwnedChannelAccount(db, user.id, c.req.param('id'))!;
    return c.json({ channel_account: toChannelAccountPublic(row) });
  });

  app.delete('/:id', (c) => {
    const user = c.get('user')!;
    const ok = deleteChannelAccount(db, user.id, c.req.param('id'));
    if (!ok) return c.json({ error: 'Channel account not found' }, 404);
    return c.json({ success: true });
  });

  return app;
}
