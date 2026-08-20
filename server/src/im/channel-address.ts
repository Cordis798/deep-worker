import type { ChannelProvider } from '../channel-accounts.js';

export const CHANNEL_PREFIXES: Record<ChannelProvider, string> = {
  telegram: 'telegram:',
  discord: 'discord:',
  whatsapp: 'whatsapp:',
  feishu: 'feishu:',
  qq: 'qq:',
  dingtalk: 'dingtalk:',
  wechat: 'wechat:',
};

export interface ChannelAddress {
  provider: ChannelProvider;
  externalChatId: string;
  channelAccountId: string | null;
  threadId: string | null;
  rootMessageId: string | null;
}

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeFragment(value: string): string {
  return encodeURIComponent(value);
}

export function buildChannelJid(input: {
  provider: ChannelProvider;
  externalChatId: string;
  channelAccountId: string;
  threadId?: string;
  rootMessageId?: string;
}): string {
  const fragments = [`account:${encodeFragment(input.channelAccountId)}`];
  if (input.threadId) fragments.push(`thread:${encodeFragment(input.threadId)}`);
  if (input.rootMessageId) fragments.push(`root:${encodeFragment(input.rootMessageId)}`);
  return `${CHANNEL_PREFIXES[input.provider]}${input.externalChatId}#${fragments.join('#')}`;
}

export function parseChannelJid(jid: string): ChannelAddress | null {
  const entry = (Object.entries(CHANNEL_PREFIXES) as Array<[ChannelProvider, string]>).find(([, prefix]) => jid.startsWith(prefix));
  if (!entry) return null;
  const [provider, prefix] = entry;
  const [externalChatId, ...fragments] = jid.slice(prefix.length).split('#');
  const account = fragments.find((part) => part.startsWith('account:'));
  const thread = fragments.find((part) => part.startsWith('thread:'));
  const root = fragments.find((part) => part.startsWith('root:'));
  return {
    provider,
    externalChatId,
    channelAccountId: account ? decodeFragment(account.slice('account:'.length)) : null,
    threadId: thread ? decodeFragment(thread.slice('thread:'.length)) : null,
    rootMessageId: root ? decodeFragment(root.slice('root:'.length)) : null,
  };
}

export function channelConversationKey(jid: string): string {
  const parsed = parseChannelJid(jid);
  if (!parsed) return jid.split('#', 1)[0] ?? jid;
  return buildChannelJid({
    provider: parsed.provider,
    externalChatId: parsed.externalChatId,
    channelAccountId: parsed.channelAccountId ?? 'legacy',
  });
}

export function isChannelJidForAccount(jid: string, accountId: string): boolean {
  return parseChannelJid(jid)?.channelAccountId === accountId;
}
