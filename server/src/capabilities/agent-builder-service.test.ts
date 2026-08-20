import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db/migration.js';
import { createAgentBuilderDraft, appendAgentBuilderTurn, prepareAgentBuilderDraft, publishAgentBuilderDraft } from './agent-builder-service.js';

function setup() {
  const db = initDatabase(':memory:');
  db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run('user-1', 'builder-user', 'hash', new Date().toISOString(), new Date().toISOString());
  return db;
}

const definition = { name: '助手', identity_prompt: '帮助用户', soul_prompt: '', agents_prompt: '', tools_prompt: '', prompt_mode: 'append' as const };

describe('Agent Builder 发布保护', () => {
  let db: ReturnType<typeof initDatabase> | undefined;

  afterEach(() => db?.close());

  it('未确认前不发布，后续用户确认成功后只发布一次', () => {
    db = setup();
    const draft = createAgentBuilderDraft(db, 'user-1', { title: '新助手', definition });
    appendAgentBuilderTurn(db, 'user-1', draft.id, { role: 'user', content: '请创建一个助手' });
    expect(() => publishAgentBuilderDraft(db!, { kind: 'user', userId: 'user-1', actionId: 'later-1', confirmationCode: 'wrong' }, draft.id)).toThrowError(expect.objectContaining({ code: 'BUILDER_NOT_READY' }));
    const prepared = prepareAgentBuilderDraft(db, 'user-1', draft.id, { previewHash: 'preview-1' });
    expect(() => publishAgentBuilderDraft(db!, { kind: 'user', userId: 'user-1', actionId: prepared.actionId, confirmationCode: prepared.confirmationCode }, draft.id)).toThrowError(expect.objectContaining({ code: 'BUILDER_LATER_ACTION_REQUIRED' }));
    expect(() => publishAgentBuilderDraft(db!, { kind: 'scheduler', userId: 'user-1', actionId: 'later-2', confirmationCode: prepared.confirmationCode }, draft.id)).toThrowError(expect.objectContaining({ code: 'BUILDER_USER_REQUIRED' }));
    const result = publishAgentBuilderDraft(db, { kind: 'user', userId: 'user-1', actionId: 'later-2', confirmationCode: prepared.confirmationCode }, draft.id);
    expect(result.profile.name).toBe('助手');
    expect(() => publishAgentBuilderDraft(db!, { kind: 'user', userId: 'user-1', actionId: 'later-3', confirmationCode: prepared.confirmationCode }, draft.id)).toThrowError(expect.objectContaining({ code: 'BUILDER_ALREADY_PUBLISHED' }));
  });

  it('错误口令不能发布', () => {
    db = setup();
    const draft = createAgentBuilderDraft(db, 'user-1', { title: '新助手', definition });
    prepareAgentBuilderDraft(db, 'user-1', draft.id, { previewHash: 'preview-1' });
    expect(() => publishAgentBuilderDraft(db!, { kind: 'user', userId: 'user-1', actionId: 'later-1', confirmationCode: '确认发布-错误' }, draft.id)).toThrowError(expect.objectContaining({ code: 'BUILDER_CONFIRMATION_INVALID' }));
  });
});
