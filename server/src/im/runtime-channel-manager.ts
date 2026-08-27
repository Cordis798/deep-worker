import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChannelProvider } from '../channel-accounts.js';
import type { RuntimeRunnerService } from '../runtime-runner-service.js';
import { AgentRouterService } from '../agent-router/service.js';
import type { ChannelTransport } from './channel-adapter.js';
import { ChannelManager } from './channel-manager.js';

function inboundId(input: { provider: string; accountId: string; chatJid: string; messageId?: string; text: string }): string {
  if (input.messageId) return `im:${input.provider}:${input.accountId}:${input.messageId}`;
  const digest = crypto.createHash('sha256').update(`${input.provider}\0${input.accountId}\0${input.chatJid}\0${input.text}`).digest('hex').slice(0, 32);
  return `im:${input.provider}:${input.accountId}:${digest}`;
}

export function createRuntimeChannelManager(options: {
  db: Database.Database;
  runnerService: RuntimeRunnerService;
  transportFactory: (provider: ChannelProvider, accountId: string) => ChannelTransport;
}) {
  const router = new AgentRouterService(options.db, options.runnerService);
  return new ChannelManager({
    db: options.db,
    transportFactory: options.transportFactory,
    onAgentMessage: async ({ ownerUserId, message, route }) => {
      const result = await options.runnerService.submit({
        ownerUserId,
        workspaceJid: route.workspaceJid,
        sessionId: route.sessionId,
        message: message.text,
        idempotencyKey: inboundId(message),
      });
      return result.reply;
    },
    onRouterMessage: async ({ ownerUserId, message, route }) => {
      const plan = router.plan({ actorUserId: ownerUserId, workspaceJid: route.workspaceJid, sessionId: route.sessionId, message: message.text });
      const result = await router.dispatch({ actorUserId: ownerUserId, workspaceJid: route.workspaceJid, planId: plan.id });
      return `编排${result.status === 'completed' ? '完成' : '未完全完成'}：${result.text ?? '无文本结果'}`;
    },
  });
}
