import { describe, expect, it } from 'vitest';
import { createUser } from './users.js';
import { createWorkspace } from './workspaces.js';
import { initDatabase } from './db/migration.js';
import { getUsageAnalytics, listUsageRecords, recordUsageEvent } from './usage-service.js';

function fixture() {
  const db = initDatabase(':memory:');
  const timestamp = new Date().toISOString();
  createUser(db, { id: 'admin', username: 'admin', password_hash: 'x', display_name: '管理员', role: 'admin', status: 'active', created_at: timestamp, updated_at: timestamp });
  const workspace = createWorkspace(db, 'admin', { name: '用量工作区', folder: 'usage-fixture' })!;
  return { db, workspace };
}

describe('用量事件账本', () => {
  it('按 eventId 幂等写入模型明细、每日/月度汇总并支持筛选', () => {
    const { db, workspace } = fixture();
    const payload = {
      inputTokens: 10,
      outputTokens: 8,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      modelUsage: { 'gpt-4o': { inputTokens: 10, outputTokens: 8, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 } },
    };
    const first = recordUsageEvent({ db, userId: 'admin', workspaceJid: workspace.jid, agentId: 'agent-a', messageId: 'message-a', eventId: 'event-a', usage: payload, createdAt: '2026-08-21T10:00:00.000Z' });
    const replay = recordUsageEvent({ db, userId: 'admin', workspaceJid: workspace.jid, eventId: 'event-a', usage: { inputTokens: 999, outputTokens: 999 }, createdAt: '2026-08-21T10:00:00.000Z' });
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(db.prepare('SELECT COUNT(*) count FROM usage_events').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT message_count FROM daily_usage WHERE user_id = ?').get('admin')).toMatchObject({ message_count: 1 });
    const analytics = getUsageAnalytics(db, { userId: 'admin', workspaceJid: workspace.jid, agentId: 'agent-a', model: 'gpt-4o', from: '2026-08-21', to: '2026-08-21' });
    expect(analytics.summary.inputTokens).toBe(10);
    expect(analytics.summary.outputTokens).toBe(8);
    expect(analytics.summary.runCount).toBe(1);
    expect(listUsageRecords(db, { userId: 'admin', from: '2026-08-21', to: '2026-08-21' }, 1, 50).total).toBe(1);
  });
});
