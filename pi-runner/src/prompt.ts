export interface PromptMessage {
  role: 'user' | 'assistant' | 'system' | string;
  content: unknown;
}

export interface PromptInput {
  systemPrompt?: string;
  history?: PromptMessage[];
  currentMessage: string;
  outputContract?: string;
  capabilities?: { hash: string; skills: string[]; mcpServers: string[]; plugins: string[] };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return String(content ?? '');
}

function roleLabel(role: string): string {
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  return 'User';
}

/** 为一次 Pi 用户回合组装结构稳定、可复现的提示词内容。 */
export function assemblePrompt(input: PromptInput): string {
  const sections: string[] = [];
  if (input.systemPrompt?.trim()) {
    sections.push(`[System prompt]\n${input.systemPrompt.trim()}`);
  }
  if (input.history && input.history.length > 0) {
    sections.push(
      `[Conversation history]\n${input.history
        .map((message) => `${roleLabel(message.role)}: ${contentToText(message.content)}`)
        .join('\n')}`,
    );
  }
  sections.push(`[Current user message]\n${input.currentMessage}`);
  if (input.outputContract?.trim()) {
    sections.push(`[Output contract]\n${input.outputContract.trim()}`);
  }
  if (input.capabilities) {
    sections.push(
      `[Pi capabilities]\nSkills: ${input.capabilities.skills.join(', ') || 'none'}\nMCP servers: ${input.capabilities.mcpServers.join(', ') || 'none'}\nPlugins: ${input.capabilities.plugins.join(', ') || 'none'}\nCapability hash: ${input.capabilities.hash}`,
    );
  }
  return sections.join('\n\n');
}
