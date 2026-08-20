import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { Db } from '../agent-profiles.js';
import { buildBuiltinManifest, importSkill, listSkills, setSkillEnabled, toPublicSkill, type SkillScope } from '../capabilities/skill-store.js';
import { createMcpServer, getMcpServer, listMcpServers, healthCheckMcpServer, setMcpEnabled, type McpTransportKind } from '../capabilities/mcp-store.js';
import { listPlugins, setPluginEnabled, upsertPlugin } from '../capabilities/plugin-catalog.js';
import { resolveCapabilitiesFromDatabase, trimCapabilityManifest } from '../capabilities/capability-resolver.js';
import { appendAgentBuilderTurn, createAgentBuilderDraft, getAgentBuilderDraft, prepareAgentBuilderDraft, publishAgentBuilderDraft, saveAgentBuilderDefinition, toPublicAgentBuilderDraft } from '../capabilities/agent-builder-service.js';
import type { AppVariables } from '../types.js';

const skillImportSchema = z.object({
  source_type: z.enum(['git', 'https', 'zip']),
  source_ref: z.string().trim().min(1).max(2000),
  project_key: z.string().trim().min(1).max(200).optional(),
  expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  version: z.string().trim().max(120).optional(),
  data_base64: z.string().optional(),
});

const mcpSchema = z.object({
  name: z.string().trim().min(1).max(120),
  transport: z.enum(['stdio', 'http']),
  command: z.string().trim().max(500).optional(),
  args: z.array(z.string().max(1000)).max(50).optional(),
  cwd: z.string().trim().max(2000).optional(),
  url: z.string().url().max(2000).optional(),
  headers: z.record(z.string(), z.string().max(2000)).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
});

const definitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  identity_prompt: z.string().max(20000).optional(),
  soul_prompt: z.string().max(20000).optional(),
  agents_prompt: z.string().max(20000).optional(),
  tools_prompt: z.string().max(20000).optional(),
  prompt_mode: z.enum(['append', 'replace']).optional(),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicManifest(manifest: ReturnType<typeof resolveCapabilitiesFromDatabase>) {
  return {
    ...manifest,
    skills: {
      ...manifest.skills,
      selected: manifest.skills.selected.map(({ path: _path, ...skill }) => skill),
      candidates: manifest.skills.candidates.map(({ path: _path, ...candidate }) => candidate),
    },
  };
}

export function createCapabilityRoutes(db: Db) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.get('/skills', (c) => {
    const user = c.get('user')!;
    const projectKey = c.req.query('project_key');
    const builtins = buildBuiltinManifest().map((skill) => ({ id: `builtin:${skill.name}`, owner_user_id: null, scope: 'system' as const, project_key: null, name: skill.name, source_type: 'builtin' as const, source_ref: 'server/skills', version: skill.version, content_hash: skill.contentHash, install_path: skill.path, manifest_json: JSON.stringify({ name: skill.name, version: skill.version }), dependencies_json: '[]', enabled: true, created_at: '', updated_at: '' }));
    return c.json({ skills: [...builtins.map(toPublicSkill), ...listSkills(db, { ownerUserId: user.id, projectKey }).map(toPublicSkill)] });
  });

  app.post('/skills', async (c) => {
    const user = c.get('user')!;
    const parsed = skillImportSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((issue) => issue.message).join('；') }, 400);
    const data = parsed.data;
    if (data.source_type === 'zip' && !data.data_base64) return c.json({ error: 'ZIP 导入必须提供 data_base64' }, 400);
    try {
      const source = data.source_type === 'zip'
        ? { type: 'zip' as const, ref: data.source_ref, data: Buffer.from(data.data_base64!, 'base64'), expectedHash: data.expected_hash, version: data.version }
        : { type: data.source_type, ref: data.source_ref, expectedHash: data.expected_hash, version: data.version } as const;
      const row = await importSkill(db, { ownerUserId: user.id, scope: data.project_key ? 'project' : 'user', ...(data.project_key ? { projectKey: data.project_key } : {}), source }, { baseDir: undefined });
      return c.json({ skill: toPublicSkill(row) }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.patch('/skills/:id', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 必须是布尔值' }, 400);
    if (!setSkillEnabled(db, user.id, c.req.param('id'), body.enabled)) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ success: true });
  });

  app.get('/mcp-servers', (c) => c.json({ mcp_servers: listMcpServers(db, c.get('user')!.id) }));

  app.post('/mcp-servers', async (c) => {
    const parsed = mcpSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((issue) => issue.message).join('；') }, 400);
    try {
      const result = createMcpServer(db, c.get('user')!.id, parsed.data as Parameters<typeof createMcpServer>[2] & { name: string; transport: McpTransportKind });
      return c.json({ mcp_server: result.row }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post('/mcp-servers/:id/health', async (c) => {
    const result = await healthCheckMcpServer(db, c.get('user')!.id, c.req.param('id'));
    return c.json(result, result.ok ? 200 : 502);
  });

  app.patch('/mcp-servers/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 必须是布尔值' }, 400);
    if (!setMcpEnabled(db, c.get('user')!.id, c.req.param('id'), body.enabled)) return c.json({ error: 'MCP Server not found' }, 404);
    return c.json({ mcp_server: getMcpServer(db, c.get('user')!.id, c.req.param('id')) });
  });

  app.get('/plugins', (c) => c.json({ plugins: listPlugins(db, c.get('user')!.id) }));

  app.post('/plugins', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name !== 'string' || typeof body.version !== 'string' || typeof body.source !== 'string') return c.json({ error: 'name、version、source 不能为空' }, 400);
    return c.json({ plugin: upsertPlugin(db, { ownerUserId: c.get('user')!.id, name: body.name, version: body.version, source: body.source, manifest: body.manifest && typeof body.manifest === 'object' ? body.manifest : {}, enabled: body.enabled === true }) }, 201);
  });

  app.patch('/plugins/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 必须是布尔值' }, 400);
    if (!setPluginEnabled(db, c.get('user')!.id, c.req.param('id'), body.enabled)) return c.json({ error: 'Plugin not found' }, 404);
    return c.json({ success: true });
  });

  app.post('/preview', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { project_key?: string; selected_skill_ids?: string[]; selected_mcp_ids?: string[]; selected_plugin_ids?: string[]; limits?: { maxSkills?: number; maxMcpServers?: number; maxPlugins?: number } };
    try {
      const manifest = resolveCapabilitiesFromDatabase(db, c.get('user')!.id, { projectKey: body.project_key, selectedSkillIds: body.selected_skill_ids, selectedMcpIds: body.selected_mcp_ids, selectedPluginIds: body.selected_plugin_ids });
      return c.json({ preview: publicManifest(body.limits ? trimCapabilityManifest(manifest, body.limits) : manifest) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post('/agent-builder/drafts', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { title?: string; definition?: unknown; workspace_jid?: string; target_agent_profile_id?: string; capability_manifest?: Record<string, unknown> };
    const parsed = definitionSchema.safeParse(body.definition);
    if (!parsed.success) return c.json({ error: 'definition 无效' }, 400);
    const draft = createAgentBuilderDraft(db, c.get('user')!.id, { title: body.title ?? parsed.data.name, definition: { name: parsed.data.name, identity_prompt: parsed.data.identity_prompt, soul_prompt: parsed.data.soul_prompt, agents_prompt: parsed.data.agents_prompt, tools_prompt: parsed.data.tools_prompt, prompt_mode: parsed.data.prompt_mode }, workspaceJid: body.workspace_jid, targetAgentProfileId: body.target_agent_profile_id, capabilityManifest: body.capability_manifest });
    return c.json({ draft: toPublicAgentBuilderDraft(draft) }, 201);
  });

  app.get('/agent-builder/drafts/:id', (c) => {
    const draft = getAgentBuilderDraft(db, c.get('user')!.id, c.req.param('id'));
    return draft ? c.json({ draft: toPublicAgentBuilderDraft(draft) }) : c.json({ error: 'Draft not found' }, 404);
  });

  app.post('/agent-builder/drafts/:id/turns', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if ((body.role !== 'user' && body.role !== 'assistant') || typeof body.content !== 'string') return c.json({ error: '消息格式无效' }, 400);
    try { return c.json({ draft: toPublicAgentBuilderDraft(appendAgentBuilderTurn(db, c.get('user')!.id, c.req.param('id'), body)) }); } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
  });

  app.put('/agent-builder/drafts/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = definitionSchema.safeParse(body.definition);
    if (!parsed.success) return c.json({ error: 'definition 无效' }, 400);
    try { return c.json({ draft: toPublicAgentBuilderDraft(saveAgentBuilderDefinition(db, c.get('user')!.id, c.req.param('id'), { name: parsed.data.name, identity_prompt: parsed.data.identity_prompt, soul_prompt: parsed.data.soul_prompt, agents_prompt: parsed.data.agents_prompt, tools_prompt: parsed.data.tools_prompt, prompt_mode: parsed.data.prompt_mode }, body.capability_manifest)) }); } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
  });

  app.post('/agent-builder/drafts/:id/prepare', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try { const result = prepareAgentBuilderDraft(db, c.get('user')!.id, c.req.param('id'), { previewHash: typeof body.preview_hash === 'string' ? body.preview_hash : undefined }); return c.json({ draft: toPublicAgentBuilderDraft(result.draft), confirmation_code: result.confirmationCode, action_id: result.actionId, expires_at: result.expiresAt }); } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
  });

  app.post('/agent-builder/drafts/:id/publish', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.confirmation_code !== 'string' || typeof body.action_id !== 'string') return c.json({ error: '需要 confirmation_code 和 action_id' }, 400);
    try { const result = publishAgentBuilderDraft(db, { kind: 'user', userId: c.get('user')!.id, actionId: body.action_id, confirmationCode: body.confirmation_code }, c.req.param('id')); return c.json({ draft: toPublicAgentBuilderDraft(result.draft), agent_profile: result.profile }, 201); } catch (error) { return c.json({ error: errorMessage(error) }, 400); }
  });

  return app;
}
