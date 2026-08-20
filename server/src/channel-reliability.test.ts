import { describe, expect, it } from 'vitest';
import { initDatabase } from './db/migration.js';
import { enqueueChannelDelivery, listReadyChannelDeliveries, markChannelDeliveryDelivered, retryChannelDelivery } from './channel-reliability.js';

describe('渠道 Outbox', () => {
  it('持久化原始回复地址并支持有界重试', () => {
    const db = initDatabase(':memory:');
    db.exec("INSERT INTO users (id, username, password_hash, display_name, role, status, permissions, must_change_password, created_at, updated_at) VALUES ('u', 'u', 'x', 'u', 'admin', 'active', '[]', 0, datetime('now'), datetime('now'))");
    const row = enqueueChannelDelivery(db, { ownerUserId: 'u', provider: 'telegram', channelAccountId: 'ca', chatJid: 'telegram:100#account:ca', sourceMessageId: 'm1', kind: 'message', payload: { text: '回复' } });
    expect(listReadyChannelDeliveries(db)).toHaveLength(1);
    const retry = retryChannelDelivery(db, row.id, '网络错误', new Date(0), 3)!;
    expect(retry.status).toBe('pending');
    expect(retry.attempts).toBe(1);
    const failed = retryChannelDelivery(db, row.id, '仍然失败', new Date(0), 2)!;
    expect(failed.status).toBe('failed');
    markChannelDeliveryDelivered(db, row.id);
    expect((db.prepare('SELECT status FROM channel_outbox WHERE id = ?').get(row.id) as { status: string }).status).toBe('delivered');
  });
});
