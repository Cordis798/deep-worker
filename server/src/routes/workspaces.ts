import { Hono } from 'hono';
import {
  bindSessionChat,
  bindWorkspaceChat,
  countWorkspaceChannelMounts,
  listSessionMounts,
  listWorkspaceMounts,
  unbindSessionChat,
  unbindWorkspaceChat,
} from '../channel-mounts.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  archiveRuntimeSession,
  createRuntimeSession,
  listRuntimeSessions,
  toRuntimeSessionPublic,
  updateRuntimeSession,
} from '../runtime-sessions.js';
import {
  bindChatSchema,
  createRuntimeSessionSchema,
  createWorkspaceSchema,
  formatZodError,
  updateRuntimeSessionSchema,
  updateWorkspaceSchema,
} from '../schemas.js';
import {
  createWorkspace,
  deleteWorkspace,
  getOwnedWorkspace,
  listOwnedWorkspaces,
  toWorkspacePublic,
  updateWorkspace,
} from '../workspaces.js';
import type { Db } from '../workspaces.js';
import type { AppVariables } from '../types.js';
import { resolveRequestedExecutionMode } from '../execution-policy.js';

export function createWorkspaceRoutes(db: Db) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.get('/', (c) => {
    const user = c.get('user')!;
    return c.json({
      workspaces: listOwnedWorkspaces(db, user.id).map(toWorkspacePublic),
    });
  });

  app.post('/', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = createWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }
    const execution = resolveRequestedExecutionMode(db, user.id, parsed.data.execution_mode);
    if (!execution.ok) return c.json({ error: '普通成员不能降级为 Host 执行' }, 403);
    const row = createWorkspace(db, user.id, {
      name: parsed.data.name,
      agent_profile_id: parsed.data.agent_profile_id,
      execution_mode: parsed.data.execution_mode,
    });
    if (!row) return c.json({ error: 'Agent profile not found' }, 404);
    return c.json({ workspace: toWorkspacePublic(row) }, 201);
  });

  app.get('/:jid', (c) => {
    const user = c.get('user')!;
    const row = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!row) return c.json({ error: 'Workspace not found' }, 404);
    return c.json({ workspace: toWorkspacePublic(row) });
  });

  app.patch('/:jid', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }
    const result = updateWorkspace(db, user.id, c.req.param('jid'), parsed.data);
    if (!result.ok) {
      if (result.reason === 'invalid_profile') {
        return c.json({ error: 'Agent profile not found' }, 404);
      }
      if (result.reason === 'home_immutable') {
        return c.json(
          {
            error: 'Home Workspace 始终属于内置 HappyClaw，不能迁移到自定义智能体',
            code: 'HOME_WORKSPACE_AGENT_IMMUTABLE',
          },
          409,
        );
      }
      if (result.reason === 'host_forbidden') return c.json({ error: '普通成员不能降级为 Host 执行' }, 403);
      return c.json({ error: 'Workspace not found' }, 404);
    }
    const row = getOwnedWorkspace(db, user.id, c.req.param('jid'))!;
    return c.json({ workspace: toWorkspacePublic(row) });
  });

  app.delete('/:jid', (c) => {
    const user = c.get('user')!;
    const jid = c.req.param('jid');
    const ownership = getOwnedWorkspace(db, user.id, jid);
    if (!ownership) return c.json({ error: 'Workspace not found' }, 404);
    const mountCount = countWorkspaceChannelMounts(db, user.id, jid)!;
    if (
      mountCount > 0 &&
      c.req.query('unbind_channels') !== 'true'
    ) {
      return c.json(
        {
          error: '该工作区绑定了 IM 渠道，请先解绑或确认删除',
          requires_unbind_confirmation: true,
          channel_mount_count: mountCount,
        },
        409,
      );
    }
    const result = deleteWorkspace(db, user.id, jid);
    if (!result.ok) {
      if (result.reason === 'home') {
        return c.json(
          { error: 'Home Workspace 不可删除', code: 'HOME_WORKSPACE_IMMUTABLE' },
          409,
        );
      }
      return c.json({ error: 'Workspace not found' }, 404);
    }
    return c.json({ success: true });
  });

  app.get('/:jid/runtime-sessions', (c) => {
    const user = c.get('user')!;
    const sessions = listRuntimeSessions(db, user.id, c.req.param('jid'));
    if (!sessions) return c.json({ error: 'Workspace not found' }, 404);
    return c.json({ sessions: sessions.map(toRuntimeSessionPublic) });
  });

  app.post('/:jid/runtime-sessions', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = createRuntimeSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }
    const result = createRuntimeSession(db, user.id, c.req.param('jid'), parsed.data);
    if (!result.ok) {
      if (result.reason === 'invalid_profile') {
        return c.json({ error: 'Agent profile not found' }, 404);
      }
      return c.json({ error: 'Workspace not found' }, 404);
    }
    const sessions = listRuntimeSessions(db, user.id, c.req.param('jid'))!;
    return c.json({ session: toRuntimeSessionPublic(sessions[0]) }, 201);
  });

  app.patch('/:jid/runtime-sessions/:sessionId', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateRuntimeSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }
    const result = updateRuntimeSession(
      db,
      user.id,
      c.req.param('jid'),
      c.req.param('sessionId'),
      parsed.data,
    );
    if (!result.ok) return c.json({ error: 'Session not found' }, 404);
    return c.json({ success: true });
  });

  app.delete('/:jid/runtime-sessions/:sessionId', (c) => {
    const user = c.get('user')!;
    const result = archiveRuntimeSession(
      db,
      user.id,
      c.req.param('jid'),
      c.req.param('sessionId'),
    );
    if (!result.ok) return c.json({ error: 'Session not found' }, 404);
    return c.json({ success: true });
  });

  app.get('/:jid/channel-mounts', (c) => {
    const user = c.get('user')!;
    const mounts = listWorkspaceMounts(db, user.id, c.req.param('jid'));
    if (!mounts) return c.json({ error: 'Workspace not found' }, 404);
    return c.json({ channel_mounts: mounts });
  });

  app.put('/:jid/im-binding', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = bindChatSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }
    const result = bindWorkspaceChat(db, user.id, c.req.param('jid'), {
      imJid: parsed.data.im_jid,
      channelType: parsed.data.channel_type,
      channelAccountId: parsed.data.channel_account_id,
    });
    if (!result.ok) {
      if (result.reason === 'wrong_type') {
        return c.json({ error: '工作区绑定只接受群聊' }, 400);
      }
      if (result.reason === 'account_not_found') {
        return c.json({ error: 'Channel account not found' }, 400);
      }
      if (result.reason === 'exists') {
        return c.json({ error: 'Channel already bound' }, 409);
      }
      return c.json({ error: 'Workspace not found' }, 404);
    }
    return c.json({ success: true }, 201);
  });

  app.delete('/:jid/im-binding/:imJid', (c) => {
    const user = c.get('user')!;
    const ok = unbindWorkspaceChat(db, user.id, c.req.param('imJid'));
    if (!ok) return c.json({ error: 'Binding not found' }, 404);
    return c.json({ success: true });
  });

  app.put('/:jid/runtime-sessions/:sessionId/im-binding', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = bindChatSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: formatZodError(parsed.error) }, 400);
    }
    const result = bindSessionChat(
      db,
      user.id,
      c.req.param('jid'),
      c.req.param('sessionId'),
      {
        imJid: parsed.data.im_jid,
        channelType: parsed.data.channel_type,
        channelAccountId: parsed.data.channel_account_id,
      },
    );
    if (!result.ok) {
      if (result.reason === 'wrong_type') {
        return c.json({ error: 'Runtime Session 绑定只接受私聊' }, 400);
      }
      if (result.reason === 'account_not_found') {
        return c.json({ error: 'Channel account not found' }, 400);
      }
      if (result.reason === 'exists') {
        return c.json({ error: 'Channel already bound' }, 409);
      }
      return c.json({ error: 'Not found' }, 404);
    }
    return c.json({ success: true }, 201);
  });

  app.delete('/:jid/runtime-sessions/:sessionId/im-binding/:imJid', (c) => {
    const user = c.get('user')!;
    const ok = unbindSessionChat(db, user.id, c.req.param('imJid'));
    if (!ok) return c.json({ error: 'Binding not found' }, 404);
    return c.json({ success: true });
  });

  app.get('/:jid/runtime-sessions/:sessionId/channel-mounts', (c) => {
    const user = c.get('user')!;
    const mounts = listSessionMounts(
      db,
      user.id,
      c.req.param('jid'),
      c.req.param('sessionId'),
    );
    if (!mounts) return c.json({ error: 'Not found' }, 404);
    return c.json({ channel_mounts: mounts });
  });

  return app;
}
