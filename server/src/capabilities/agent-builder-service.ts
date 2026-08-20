import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  createAgentProfile,
  getOwnedAgentProfile,
  updateAgentProfile,
  type AgentProfileFields,
  type AgentProfileRow,
} from '../agent-profiles.js';

export type BuilderDraftStatus = 'draft' | 'ready' | 'published' | 'cancelled';
export type BuilderTurn = { role: 'user' | 'assistant'; content: string; created_at: string };

export interface AgentBuilderDefinition extends AgentProfileFields {}

export interface AgentBuilderDraft {
  id: string;
  owner_user_id: string;
  workspace_jid: string | null;
  target_agent_profile_id: string | null;
  title: string;
  transcript: BuilderTurn[];
  definition: AgentBuilderDefinition;
  capability_manifest: Record<string, unknown>;
  preview_hash: string | null;
  status: BuilderDraftStatus;
  created_at: string;
  updated_at: string;
}

export class AgentBuilderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentBuilderError';
  }
}

function parseDraft(row: Record<string, unknown>): AgentBuilderDraft {
  return {
    id: String(row.id),
    owner_user_id: String(row.owner_user_id),
    workspace_jid: (row.workspace_jid as string | null) ?? null,
    target_agent_profile_id: (row.target_agent_profile_id as string | null) ?? null,
    title: String(row.title),
    transcript: JSON.parse(String(row.transcript_json)) as BuilderTurn[],
    definition: JSON.parse(String(row.definition_json)) as AgentBuilderDefinition,
    capability_manifest: JSON.parse(String(row.capability_json)) as Record<string, unknown>,
    preview_hash: (row.preview_hash as string | null) ?? null,
    status: String(row.status) as BuilderDraftStatus,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function getAgentBuilderDraft(db: Database.Database, ownerUserId: string, id: string): AgentBuilderDraft | undefined {
  const row = db.prepare('SELECT * FROM agent_builder_drafts WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId) as Record<string, unknown> | undefined;
  return row ? parseDraft(row) : undefined;
}

export function createAgentBuilderDraft(db: Database.Database, ownerUserId: string, input: { title: string; definition: AgentBuilderDefinition; workspaceJid?: string; targetAgentProfileId?: string; capabilityManifest?: Record<string, unknown> }): AgentBuilderDraft {
  const id = `draft_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO agent_builder_drafts (id, owner_user_id, workspace_jid, target_agent_profile_id, title, transcript_json, definition_json, capability_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 'draft', ?, ?)`).run(id, ownerUserId, input.workspaceJid ?? null, input.targetAgentProfileId ?? null, input.title.trim() || input.definition.name, JSON.stringify(input.definition), JSON.stringify(input.capabilityManifest ?? {}), timestamp, timestamp);
  return getAgentBuilderDraft(db, ownerUserId, id)!;
}

export function appendAgentBuilderTurn(db: Database.Database, ownerUserId: string, draftId: string, turn: { role: 'user' | 'assistant'; content: string }): AgentBuilderDraft {
  const draft = getAgentBuilderDraft(db, ownerUserId, draftId);
  if (!draft) throw new AgentBuilderError('BUILDER_NOT_FOUND', '草稿不存在');
  if (draft.status !== 'draft') throw new AgentBuilderError('BUILDER_NOT_EDITABLE', '草稿当前不可编辑');
  const transcript = [...draft.transcript, { ...turn, created_at: new Date().toISOString() }];
  db.prepare('UPDATE agent_builder_drafts SET transcript_json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?').run(JSON.stringify(transcript), new Date().toISOString(), draftId, ownerUserId);
  return getAgentBuilderDraft(db, ownerUserId, draftId)!;
}

export function saveAgentBuilderDefinition(db: Database.Database, ownerUserId: string, draftId: string, definition: AgentBuilderDefinition, capabilityManifest?: Record<string, unknown>): AgentBuilderDraft {
  const draft = getAgentBuilderDraft(db, ownerUserId, draftId);
  if (!draft) throw new AgentBuilderError('BUILDER_NOT_FOUND', '草稿不存在');
  if (draft.status !== 'draft') throw new AgentBuilderError('BUILDER_NOT_EDITABLE', '草稿当前不可编辑');
  db.prepare('UPDATE agent_builder_drafts SET title = ?, definition_json = ?, capability_json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?').run(definition.name, JSON.stringify(definition), JSON.stringify(capabilityManifest ?? draft.capability_manifest), new Date().toISOString(), draftId, ownerUserId);
  return getAgentBuilderDraft(db, ownerUserId, draftId)!;
}

function hashConfirmation(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function prepareAgentBuilderDraft(db: Database.Database, ownerUserId: string, draftId: string, input: { previewHash?: string; ttlMs?: number }): { draft: AgentBuilderDraft; confirmationCode: string; actionId: string; expiresAt: string } {
  const draft = getAgentBuilderDraft(db, ownerUserId, draftId);
  if (!draft) throw new AgentBuilderError('BUILDER_NOT_FOUND', '草稿不存在');
  if (draft.status !== 'draft') throw new AgentBuilderError('BUILDER_NOT_EDITABLE', '草稿当前不可准备发布');
  const confirmationCode = `确认发布-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const actionId = `prepare_${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 10 * 60_000)).toISOString();
  db.prepare('UPDATE agent_builder_drafts SET status = \'ready\', preview_hash = ?, confirmation_hash = ?, confirmation_expires_at = ?, prepared_action_id = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?').run(input.previewHash ?? null, hashConfirmation(confirmationCode), expiresAt, actionId, new Date().toISOString(), draftId, ownerUserId);
  return { draft: getAgentBuilderDraft(db, ownerUserId, draftId)!, confirmationCode, actionId, expiresAt };
}

export type BuilderActor = { kind: 'user' | 'scheduler' | 'subagent'; userId: string; actionId: string; confirmationCode: string };

export function publishAgentBuilderDraft(db: Database.Database, actor: BuilderActor, draftId: string): { draft: AgentBuilderDraft; profile: AgentProfileRow } {
  const draft = getAgentBuilderDraft(db, actor.userId, draftId);
  if (!draft) throw new AgentBuilderError('BUILDER_NOT_FOUND', '草稿不存在');
  if (draft.status === 'published') throw new AgentBuilderError('BUILDER_ALREADY_PUBLISHED', '草稿已经发布');
  if (draft.status !== 'ready') throw new AgentBuilderError('BUILDER_NOT_READY', '草稿尚未准备确认');
  if (actor.kind !== 'user') throw new AgentBuilderError('BUILDER_USER_REQUIRED', '只有用户可以发布 Agent');
  const stored = db.prepare('SELECT confirmation_hash, confirmation_expires_at, prepared_action_id FROM agent_builder_drafts WHERE id = ? AND owner_user_id = ?').get(draftId, actor.userId) as { confirmation_hash?: string; confirmation_expires_at?: string; prepared_action_id?: string } | undefined;
  if (!stored?.confirmation_hash || !stored.confirmation_expires_at || new Date(stored.confirmation_expires_at).getTime() <= Date.now()) throw new AgentBuilderError('BUILDER_CONFIRMATION_EXPIRED', '确认口令已过期');
  if (actor.actionId === stored.prepared_action_id) throw new AgentBuilderError('BUILDER_LATER_ACTION_REQUIRED', '发布必须来自准备操作之后的用户操作');
  if (hashConfirmation(actor.confirmationCode.trim()) !== stored.confirmation_hash) throw new AgentBuilderError('BUILDER_CONFIRMATION_INVALID', '确认口令错误');
  const definition = draft.definition;
  let profile: AgentProfileRow;
  if (draft.target_agent_profile_id) {
    if (!getOwnedAgentProfile(db, actor.userId, draft.target_agent_profile_id)) throw new AgentBuilderError('BUILDER_TARGET_NOT_FOUND', '目标 Agent 不存在');
    const update = updateAgentProfile(db, actor.userId, draft.target_agent_profile_id, definition);
    if (!update.ok) throw new AgentBuilderError('BUILDER_TARGET_NOT_EDITABLE', '目标 Agent 不可更新');
    profile = getOwnedAgentProfile(db, actor.userId, draft.target_agent_profile_id)!;
  } else {
    profile = createAgentProfile(db, actor.userId, definition);
  }
  db.prepare("UPDATE agent_builder_drafts SET status = 'published', confirmation_hash = NULL, confirmation_expires_at = NULL, prepared_action_id = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(new Date().toISOString(), draftId, actor.userId);
  return { draft: getAgentBuilderDraft(db, actor.userId, draftId)!, profile };
}

export function toPublicAgentBuilderDraft(draft: AgentBuilderDraft) {
  return { ...draft, capability_manifest: draft.capability_manifest, confirmation_required: draft.status === 'ready' };
}
