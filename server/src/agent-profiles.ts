import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export type Db = Database.Database;

export type AgentProfileStatus = 'active' | 'archived';

export interface AgentProfileRow {
  id: string;
  owner_user_id: string;
  name: string;
  identity_prompt: string;
  soul_prompt: string;
  agents_prompt: string;
  tools_prompt: string;
  prompt_mode: string;
  identity_hash: string;
  version: number;
  is_default: number;
  status: AgentProfileStatus;
  created_at: string;
  updated_at: string;
}

export interface PromptVersionRow {
  id: string;
  agent_profile_id: string;
  version: number;
  name: string;
  identity_prompt: string;
  soul_prompt: string;
  agents_prompt: string;
  tools_prompt: string;
  prompt_mode: string;
  identity_hash: string;
  change_source: 'create' | 'update' | 'restore';
  restored_from_version: number | null;
  created_at: string;
}

export interface AgentProfileFields {
  name: string;
  identity_prompt?: string;
  soul_prompt?: string;
  agents_prompt?: string;
  tools_prompt?: string;
  prompt_mode?: 'append' | 'replace';
}

export function generateAgentProfileId(): string {
  return `ap_${crypto.randomUUID()}`;
}

interface ProfileContent {
  identity_prompt: string;
  soul_prompt: string;
  agents_prompt: string;
  tools_prompt: string;
  prompt_mode: 'append' | 'replace';
}

export function computeIdentityHash(profile: ProfileContent): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        profile.identity_prompt,
        profile.soul_prompt,
        profile.agents_prompt,
        profile.tools_prompt,
        profile.prompt_mode,
      ]),
    )
    .digest('hex');
}

function insertPromptVersion(
  db: Db,
  profileId: string,
  version: number,
  fields: AgentProfileFields,
  identityHash: string,
  changeSource: PromptVersionRow['change_source'],
  restoredFromVersion: number | null,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO agent_profile_prompt_versions (
      id, agent_profile_id, version, name, identity_prompt, soul_prompt,
      agents_prompt, tools_prompt, prompt_mode, identity_hash, change_source,
      restored_from_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `pv_${crypto.randomUUID()}`,
    profileId,
    version,
    fields.name,
    fields.identity_prompt ?? '',
    fields.soul_prompt ?? '',
    fields.agents_prompt ?? '',
    fields.tools_prompt ?? '',
    fields.prompt_mode ?? 'append',
    identityHash,
    changeSource,
    restoredFromVersion,
    createdAt,
  );
}

export function createAgentProfile(
  db: Db,
  ownerUserId: string,
  fields: AgentProfileFields,
  options: { isDefault?: boolean; createdAt?: string; id?: string; name?: string } = {},
): AgentProfileRow {
  const now = options.createdAt ?? new Date().toISOString();
  const id = options.id ?? generateAgentProfileId();
  const promptMode = fields.prompt_mode ?? 'append';
  const identityHash = computeIdentityHash({
    identity_prompt: fields.identity_prompt ?? '',
    soul_prompt: fields.soul_prompt ?? '',
    agents_prompt: fields.agents_prompt ?? '',
    tools_prompt: fields.tools_prompt ?? '',
    prompt_mode: promptMode,
  });

  if (options.isDefault) {
    db.prepare(
      'UPDATE agent_profiles SET is_default = 0 WHERE owner_user_id = ? AND status = ?',
    ).run(ownerUserId, 'active');
  }
  db.prepare(
    `INSERT INTO agent_profiles (
      id, owner_user_id, name, identity_prompt, soul_prompt, agents_prompt,
      tools_prompt, prompt_mode, identity_hash, version, is_default, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ownerUserId,
    fields.name,
    fields.identity_prompt ?? '',
    fields.soul_prompt ?? '',
    fields.agents_prompt ?? '',
    fields.tools_prompt ?? '',
    promptMode,
    identityHash,
    1,
    options.isDefault ? 1 : 0,
    'active',
    now,
    now,
  );
  insertPromptVersion(
    db,
    id,
    1,
    fields,
    identityHash,
    'create',
    null,
    now,
  );
  return getAgentProfileById(db, id)!;
}

export function getAgentProfileById(
  db: Db,
  id: string,
): AgentProfileRow | undefined {
  return db
    .prepare('SELECT * FROM agent_profiles WHERE id = ?')
    .get(id) as AgentProfileRow | undefined;
}

export function getOwnedAgentProfile(
  db: Db,
  ownerUserId: string,
  id: string,
): AgentProfileRow | undefined {
  return db
    .prepare(
      'SELECT * FROM agent_profiles WHERE id = ? AND owner_user_id = ?',
    )
    .get(id, ownerUserId) as AgentProfileRow | undefined;
}

export function listOwnedAgentProfiles(
  db: Db,
  ownerUserId: string,
): AgentProfileRow[] {
  return db
    .prepare(
      'SELECT * FROM agent_profiles WHERE owner_user_id = ? ORDER BY updated_at DESC',
    )
    .all(ownerUserId) as AgentProfileRow[];
}

function promptFieldsChanged(
  row: AgentProfileRow,
  merged: AgentProfileFields,
): boolean {
  return (
    row.identity_prompt !== merged.identity_prompt ||
    row.soul_prompt !== merged.soul_prompt ||
    row.agents_prompt !== merged.agents_prompt ||
    row.tools_prompt !== merged.tools_prompt ||
    row.prompt_mode !== merged.prompt_mode
  );
}

export function updateAgentProfile(
  db: Db,
  ownerUserId: string,
  id: string,
  fields: Partial<AgentProfileFields>,
): { ok: boolean; reason?: 'not_found' | 'archived' } {
  const row = getOwnedAgentProfile(db, ownerUserId, id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'archived') return { ok: false, reason: 'archived' };

  const merged: AgentProfileFields = {
    name: fields.name ?? row.name,
    identity_prompt: fields.identity_prompt ?? row.identity_prompt,
    soul_prompt: fields.soul_prompt ?? row.soul_prompt,
    agents_prompt: fields.agents_prompt ?? row.agents_prompt,
    tools_prompt: fields.tools_prompt ?? row.tools_prompt,
    prompt_mode: fields.prompt_mode ?? (row.prompt_mode as 'append' | 'replace'),
  };
  const nameChanged = merged.name !== row.name;
  const promptChanged = promptFieldsChanged(row, merged);
  const nextVersion = nameChanged || promptChanged ? row.version + 1 : row.version;
  const identityHash = computeIdentityHash({
    identity_prompt: merged.identity_prompt!,
    soul_prompt: merged.soul_prompt!,
    agents_prompt: merged.agents_prompt!,
    tools_prompt: merged.tools_prompt!,
    prompt_mode: merged.prompt_mode!,
  });
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      `UPDATE agent_profiles SET name = ?, identity_prompt = ?, soul_prompt = ?,
        agents_prompt = ?, tools_prompt = ?, prompt_mode = ?, identity_hash = ?,
        version = ?, updated_at = ? WHERE id = ?`,
    ).run(
      merged.name,
      merged.identity_prompt,
      merged.soul_prompt,
      merged.agents_prompt,
      merged.tools_prompt,
      merged.prompt_mode,
      identityHash,
      nextVersion,
      now,
      id,
    );
    if (promptChanged) {
      insertPromptVersion(
        db,
        id,
        nextVersion,
        merged,
        identityHash,
        'update',
        null,
        now,
      );
    }
  })();
  return { ok: true };
}

export interface DeleteProfileResult {
  ok: boolean;
  reason?: 'not_found' | 'is_default' | 'has_workspaces' | 'has_mounts';
}

export function deleteAgentProfile(
  db: Db,
  ownerUserId: string,
  id: string,
): DeleteProfileResult {
  const row = getOwnedAgentProfile(db, ownerUserId, id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.is_default === 1) return { ok: false, reason: 'is_default' };
  const workspaceCount = db
    .prepare('SELECT COUNT(*) AS count FROM workspaces WHERE owner_user_id = ? AND agent_profile_id = ?')
    .get(ownerUserId, id) as { count: number };
  if (workspaceCount.count > 0) return { ok: false, reason: 'has_workspaces' };
  db.prepare(
    "UPDATE agent_profiles SET status = 'archived', updated_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
  return { ok: true };
}

export function listPromptVersions(
  db: Db,
  ownerUserId: string,
  agentProfileId: string,
): PromptVersionRow[] | undefined {
  const row = getOwnedAgentProfile(db, ownerUserId, agentProfileId);
  if (!row) return undefined;
  return db
    .prepare(
      'SELECT * FROM agent_profile_prompt_versions WHERE agent_profile_id = ? ORDER BY version DESC',
    )
    .all(agentProfileId) as PromptVersionRow[];
}

export function restorePromptVersion(
  db: Db,
  ownerUserId: string,
  agentProfileId: string,
  version: number,
): { ok: boolean; reason?: 'profile_not_found' | 'archived' | 'version_not_found' } {
  const profile = getOwnedAgentProfile(db, ownerUserId, agentProfileId);
  if (!profile) return { ok: false, reason: 'profile_not_found' };
  if (profile.status === 'archived') return { ok: false, reason: 'archived' };
  const source = db
    .prepare(
      'SELECT * FROM agent_profile_prompt_versions WHERE agent_profile_id = ? AND version = ?',
    )
    .get(agentProfileId, version) as PromptVersionRow | undefined;
  if (!source) return { ok: false, reason: 'version_not_found' };

  const merged: AgentProfileFields = {
    name: profile.name,
    identity_prompt: source.identity_prompt,
    soul_prompt: source.soul_prompt,
    agents_prompt: source.agents_prompt,
    tools_prompt: source.tools_prompt,
    prompt_mode: source.prompt_mode as 'append' | 'replace',
  };
  const promptChanged = promptFieldsChanged(profile, merged);
  const nextVersion = promptChanged ? profile.version + 1 : profile.version;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE agent_profiles SET name = ?, identity_prompt = ?, soul_prompt = ?,
        agents_prompt = ?, tools_prompt = ?, prompt_mode = ?, identity_hash = ?,
        version = ?, updated_at = ? WHERE id = ?`,
    ).run(
      merged.name,
      merged.identity_prompt,
      merged.soul_prompt,
      merged.agents_prompt,
      merged.tools_prompt,
      merged.prompt_mode,
      source.identity_hash,
      nextVersion,
      now,
      agentProfileId,
    );
    if (promptChanged) {
      insertPromptVersion(
        db,
        agentProfileId,
        nextVersion,
        merged,
        source.identity_hash,
        'restore',
        version,
        now,
      );
    }
  })();
  return { ok: true };
}

export function toAgentProfilePublic(row: AgentProfileRow) {
  return {
    id: row.id,
    name: row.name,
    identity_prompt: row.identity_prompt,
    soul_prompt: row.soul_prompt,
    agents_prompt: row.agents_prompt,
    tools_prompt: row.tools_prompt,
    prompt_mode: row.prompt_mode,
    version: row.version,
    is_default: row.is_default === 1,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
