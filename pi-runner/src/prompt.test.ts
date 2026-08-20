import { describe, expect, it } from 'vitest';
import { assemblePrompt } from './prompt.js';

describe('prompt assembly', () => {
  it('keeps system prompt, history, current message and output contract distinct', () => {
    const result = assemblePrompt({
      systemPrompt: 'You are helpful.',
      history: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
      ],
      currentMessage: 'new question',
      outputContract: 'Return a concise answer.',
    });
    expect(result).toContain('[System prompt]\nYou are helpful.');
    expect(result).toContain('[Conversation history]\nUser: old question\nAssistant: old answer');
    expect(result).toContain('[Current user message]\nnew question');
    expect(result).toContain('[Output contract]\nReturn a concise answer.');
    expect(result.indexOf('new question')).toBeGreaterThan(result.indexOf('old answer'));
  });

  it('does not invent optional sections', () => {
    expect(assemblePrompt({ currentMessage: 'hello' })).toBe(
      '[Current user message]\nhello',
    );
  });

  it('把能力摘要和 hash 注入提示词，不注入路径或凭据', () => {
    const result = assemblePrompt({
      currentMessage: 'hello',
      capabilities: { hash: 'abc', skills: ['bash'], mcpServers: ['demo'], plugins: [] },
    });
    expect(result).toContain('[Pi capabilities]');
    expect(result).toContain('Skills: bash');
    expect(result).toContain('Capability hash: abc');
  });
});
