import type Database from 'better-sqlite3';
import {
  getChannelAccountCredentials,
  getOwnedChannelAccount,
  type ChannelProvider,
} from '../channel-accounts.js';
import {
  enqueueChannelDelivery,
  listReadyChannelDeliveries,
  markChannelDeliveryDelivered,
  retryChannelDelivery,
  type ChannelOutboxRow,
} from '../channel-reliability.js';
import type { ChannelInboundMessage, ChannelTransport } from './channel-adapter.js';
import { parseChannelJid } from './channel-address.js';
import { createChannelCommandService } from './channel-commands.js';
import { createDefaultChannelAdapterRegistry, type ChannelAdapterRegistry } from './channel-registry.js';
import { createChannelMountService, type ChannelRoute } from './channel-mount-service.js';

export interface ChannelAgentMessageInput {
  ownerUserId: string;
  message: ChannelInboundMessage;
  route: ChannelRoute;
}

export interface ChannelManagerOptions {
  db: Database.Database;
  transportFactory: (provider: ChannelProvider, accountId: string) => ChannelTransport;
  registry?: ChannelAdapterRegistry;
  onAgentMessage?: (input: ChannelAgentMessageInput) => Promise<string | null>;
  onRouterMessage?: (input: ChannelAgentMessageInput) => Promise<string | null>;
  onRouterApproval?: (input: { ownerUserId: string; planId: string; approved: boolean; message: ChannelInboundMessage; route: ChannelRoute }) => Promise<string | null>;
  retryBaseMs?: number;
  maxAttempts?: number;
}

export class ChannelManager {
  private readonly db: Database.Database;
  private readonly transportFactory: ChannelManagerOptions['transportFactory'];
  private readonly registry: ChannelAdapterRegistry;
  private readonly mounts;
  private readonly commands;
  private readonly onAgentMessage?: ChannelManagerOptions['onAgentMessage'];
  private readonly retryBaseMs: number;
  private readonly maxAttempts: number;
  private readonly adapters = new Map<string, { ownerUserId: string; adapter: ReturnType<ChannelAdapterRegistry['create']>; unsubscribe: () => void }>();
  private readonly tasks = new Set<Promise<void>>();

  constructor(options: ChannelManagerOptions) {
    this.db = options.db;
    this.transportFactory = options.transportFactory;
    this.registry = options.registry ?? createDefaultChannelAdapterRegistry();
    this.mounts = createChannelMountService(this.db);
    this.onAgentMessage = options.onAgentMessage;
    this.retryBaseMs = options.retryBaseMs ?? 100;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.commands = createChannelCommandService({
      db: this.db,
      mounts: this.mounts,
      onRouteMessage: options.onRouterMessage,
      onSingleMessage: options.onAgentMessage,
      onRouterApproval: options.onRouterApproval,
    });
  }

  async connectAccount(ownerUserId: string, accountId: string): Promise<void> {
    const account = getOwnedChannelAccount(this.db, ownerUserId, accountId);
    if (!account) throw new Error('渠道账号不存在');
    await this.disconnectAccount(accountId);
    const transport = this.transportFactory(account.provider as ChannelProvider, account.id);
    const adapter = this.registry.create(account.provider as ChannelProvider, transport);
    const unsubscribe = adapter.onMessage((message) => this.schedule(this.handleInbound(ownerUserId, message)));
    this.adapters.set(accountId, { ownerUserId, adapter, unsubscribe });
    try {
      await adapter.connect({ accountId, credentials: getChannelAccountCredentials(this.db, ownerUserId, accountId) ?? {} });
      this.updateAccountStatus(ownerUserId, accountId, adapter.getStatus().status);
      await this.flushPending();
    } catch (error) {
      this.updateAccountStatus(ownerUserId, accountId, 'error');
      unsubscribe();
      this.adapters.delete(accountId);
      throw error;
    }
  }

  async reconnectAccount(ownerUserId: string, accountId: string): Promise<void> {
    const current = this.adapters.get(accountId);
    if (!current) {
      await this.connectAccount(ownerUserId, accountId);
      return;
    }
    await current.adapter.reconnect();
    this.updateAccountStatus(ownerUserId, accountId, current.adapter.getStatus().status);
    await this.flushPending();
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const current = this.adapters.get(accountId);
    if (!current) return;
    current.unsubscribe();
    this.adapters.delete(accountId);
    await current.adapter.disconnect();
    this.updateAccountStatus(current.ownerUserId, accountId, 'disconnected');
  }

  async sendMessage(ownerUserId: string, chatJid: string, text: string, sourceMessageId?: string): Promise<void> {
    await this.enqueueAndFlush(ownerUserId, chatJid, 'message', { text }, sourceMessageId);
  }

  async sendFile(ownerUserId: string, chatJid: string, filePath: string, fileName: string, sourceMessageId?: string): Promise<void> {
    await this.enqueueAndFlush(ownerUserId, chatJid, 'file', { filePath, fileName }, sourceMessageId);
  }

  async sendImage(ownerUserId: string, chatJid: string, data: Uint8Array, mimeType: string, caption?: string, fileName?: string, sourceMessageId?: string): Promise<void> {
    await this.enqueueAndFlush(ownerUserId, chatJid, 'image', { dataBase64: Buffer.from(data).toString('base64'), mimeType, ...(caption ? { caption } : {}), ...(fileName ? { fileName } : {}) }, sourceMessageId);
  }

  async react(ownerUserId: string, chatJid: string, reaction: string, sourceMessageId?: string): Promise<void> {
    await this.enqueueAndFlush(ownerUserId, chatJid, 'reaction', { reaction }, sourceMessageId);
  }

  async sendStreamingUpdate(ownerUserId: string, chatJid: string, text: string, streamId: string, final: boolean): Promise<void> {
    const address = parseChannelJid(chatJid);
    if (!address?.channelAccountId) throw new Error('渠道回复地址缺少账号身份');
    const connection = this.adapters.get(address.channelAccountId);
    if (!connection || connection.ownerUserId !== ownerUserId) throw new Error('渠道账号尚未连接');
    await connection.adapter.sendStreamingUpdate(chatJid, text, streamId, final);
  }

  async flushPending(): Promise<void> {
    for (const row of listReadyChannelDeliveries(this.db)) {
      const connection = this.adapters.get(row.channelAccountId);
      if (!connection || connection.ownerUserId !== row.ownerUserId) continue;
      try {
        await this.deliver(row, connection.adapter);
        markChannelDeliveryDelivered(this.db, row.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const delay = Math.min(5_000, this.retryBaseMs * 2 ** row.attempts);
        retryChannelDelivery(this.db, row.id, message, new Date(Date.now() + delay), this.maxAttempts);
      }
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
  }

  async close(): Promise<void> {
    await Promise.all([...this.adapters.keys()].map((accountId) => this.disconnectAccount(accountId)));
    await this.waitForIdle();
  }

  private schedule(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private async handleInbound(ownerUserId: string, message: ChannelInboundMessage): Promise<void> {
    const connection = this.adapters.get(message.accountId);
    const command = await this.commands.execute(message.text, { ownerUserId, message, connection: connection?.adapter.getStatus() });
    if (command.handled) {
      await this.sendMessage(ownerUserId, message.chatJid, command.reply, message.messageId);
      return;
    }
    const resolved = this.mounts.resolveInbound({ ownerUserId, message });
    if (resolved.status !== 'resolved') {
      const reply = resolved.status === 'unbound' ? '当前群聊尚未绑定工作区，请先使用 /bind。' : '当前聊天暂时不可用，请检查渠道账号和默认工作区。';
      await this.sendMessage(ownerUserId, message.chatJid, reply, message.messageId);
      return;
    }
    const reply = this.onAgentMessage ? await this.onAgentMessage({ ownerUserId, message, route: resolved.route }) : null;
    if (reply) await this.sendMessage(ownerUserId, message.chatJid, reply, message.messageId);
  }

  private async enqueueAndFlush(ownerUserId: string, chatJid: string, kind: 'message' | 'file' | 'image' | 'reaction', payload: Parameters<typeof enqueueChannelDelivery>[1]['payload'], sourceMessageId?: string): Promise<void> {
    const address = parseChannelJid(chatJid);
    if (!address?.channelAccountId) throw new Error('渠道回复地址缺少账号身份');
    const account = getOwnedChannelAccount(this.db, ownerUserId, address.channelAccountId);
    if (!account || account.provider !== address.provider) throw new Error('渠道回复账号不存在');
    enqueueChannelDelivery(this.db, { ownerUserId, provider: address.provider, channelAccountId: address.channelAccountId, chatJid, sourceMessageId, kind, payload });
    await this.flushPending();
  }

  private updateAccountStatus(ownerUserId: string, accountId: string, status: string): void {
    this.db.prepare('UPDATE channel_accounts SET status = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?').run(status, new Date().toISOString(), accountId, ownerUserId);
  }

  private async deliver(row: ChannelOutboxRow, adapter: ReturnType<ChannelAdapterRegistry['create']>): Promise<void> {
    if (row.kind === 'message') return adapter.sendMessage(row.chatJid, row.payload.text ?? '');
    if (row.kind === 'file') return adapter.sendFile(row.chatJid, row.payload.filePath ?? '', row.payload.fileName ?? '文件');
    if (row.kind === 'image') return adapter.sendImage(row.chatJid, Buffer.from(row.payload.dataBase64 ?? '', 'base64'), row.payload.mimeType ?? 'application/octet-stream', row.payload.caption, row.payload.fileName);
    return adapter.react(row.chatJid, row.payload.reaction ?? '');
  }
}
