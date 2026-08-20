import { z } from 'zod';

const nonEmptyString = (label: string, max: number) =>
  z.string().trim().min(1, `${label} 不能为空`).max(max, `${label} 长度不能超过 ${max}`);

export const createAgentProfileSchema = z.object({
  name: nonEmptyString('名称', 120),
  identity_prompt: z.string().max(20000).optional(),
  soul_prompt: z.string().max(20000).optional(),
  agents_prompt: z.string().max(20000).optional(),
  tools_prompt: z.string().max(20000).optional(),
  prompt_mode: z.enum(['append', 'replace']).optional(),
  is_default: z.boolean().optional(),
});

export const updateAgentProfileSchema = z
  .object({
    name: nonEmptyString('名称', 120).optional(),
    identity_prompt: z.string().max(20000).optional(),
    soul_prompt: z.string().max(20000).optional(),
    agents_prompt: z.string().max(20000).optional(),
    tools_prompt: z.string().max(20000).optional(),
    prompt_mode: z.enum(['append', 'replace']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: '至少需要提供一个可修改字段',
  });

export const createWorkspaceSchema = z.object({
  name: nonEmptyString('名称', 120),
  agent_profile_id: z.string().optional().nullable(),
});

export const updateWorkspaceSchema = z
  .object({
    name: nonEmptyString('名称', 120).optional(),
    agent_profile_id: z.string().optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: '至少需要提供一个可修改字段',
  });

export const createRuntimeSessionSchema = z.object({
  name: z.string().max(120).optional(),
  agent_profile_id: z.string().optional().nullable(),
});

export const updateRuntimeSessionSchema = z
  .object({
    name: z.string().max(120).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: '至少需要提供一个可修改字段',
  });

export const createChannelAccountSchema = z.object({
  provider: z.enum(['feishu', 'telegram', 'qq', 'dingtalk', 'wechat', 'discord', 'whatsapp']),
  name: nonEmptyString('账号名', 80),
  credentials: z.record(z.string(), z.unknown()).optional(),
  is_default: z.boolean().optional(),
  default_workspace_jid: z.string().optional().nullable(),
});

export const updateChannelAccountSchema = z
  .object({
    name: nonEmptyString('账号名', 80).optional(),
    enabled: z.boolean().optional(),
    is_default: z.boolean().optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
    default_workspace_jid: z.string().optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: '至少需要提供一个可修改字段',
  });

export const bindChatSchema = z.object({
  im_jid: nonEmptyString('渠道 JID', 256),
  channel_type: z.enum(['group', 'private']),
  channel_account_id: z.string().optional(),
});

export const createRunnerMessageSchema = z.object({
  message: nonEmptyString('消息', 50_000),
  idempotency_key: nonEmptyString('幂等键', 200).optional(),
  system_prompt: z.string().max(20_000).optional(),
  output_contract: z.string().max(20_000).optional(),
});

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('；');
}
