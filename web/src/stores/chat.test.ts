import { describe, expect, it, vi } from 'vitest';

const { post, openTurnStream } = vi.hoisted(() => {
  const post = vi.fn();
  const openTurnStream = vi.fn(
    (
      _workspace: string,
      _session: string,
      _turn: string,
      handlers: { onEvent: (event: unknown) => void },
    ) => {
      queueMicrotask(() => {
        handlers.onEvent({ eventType: 'init', statusText: 'agent started' });
        handlers.onEvent({
          eventType: 'tool_use_start',
          toolName: 'bash',
          toolUseId: 'tool-1',
        });
        handlers.onEvent({ eventType: 'text_delta', text: '你好' });
        handlers.onEvent({ eventType: 'status', statusText: 'agent settled' });
      });
      return { close: vi.fn() };
    },
  );
  return { post, openTurnStream };
});

vi.mock('../api/client.js', () => ({
  api: { post },
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : '失败'),
}));
vi.mock('../api/ws.js', () => ({ openTurnStream }));

import { EMPTY_MESSAGES, selectSessionMessages, useChatStore } from './chat.js';

describe('聊天流状态', () => {
  it('没有会话消息时复用稳定的空数组引用', () => {
    const state = { messages: {} };
    expect(selectSessionMessages(state, null)).toBe(EMPTY_MESSAGES);
    expect(selectSessionMessages(state, 'missing')).toBe(EMPTY_MESSAGES);
  });

  it('聚合文本、工具轨迹并在终态结束生成', async () => {
    post.mockResolvedValueOnce({ turn: { id: 'turn_1' } });
    useChatStore.setState({ messages: {}, activeTurns: {}, sendError: {} });
    await useChatStore.getState().sendMessage('web:one', 'rs_one', '开始');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const messages = useChatStore.getState().messages.rs_one;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.text).toBe('开始');
    expect(messages[1]?.text).toBe('你好');
    expect(messages[1]?.events.map((event) => event.eventType)).toEqual([
      'init',
      'tool_use_start',
      'text_delta',
      'status',
    ]);
    expect(messages[1]?.status).toBe('complete');
    expect(useChatStore.getState().activeTurns.rs_one).toBeUndefined();
  });

  it('连接建立前收到终态也不会留下活动会话', async () => {
    post.mockResolvedValueOnce({ turn: { id: 'turn_sync' } });
    openTurnStream.mockImplementationOnce((_workspace, _session, _turn, handlers) => {
      handlers.onEvent({ eventType: 'status', statusText: 'agent settled' });
      return { close: vi.fn() };
    });
    useChatStore.setState({ messages: {}, activeTurns: {}, sendError: {} });

    await useChatStore.getState().sendMessage('web:one', 'rs_sync', '同步终态');

    expect(useChatStore.getState().messages.rs_sync?.[1]?.status).toBe('complete');
    expect(useChatStore.getState().activeTurns.rs_sync).toBeUndefined();
    expect(openTurnStream.mock.results[1]?.value.close).toHaveBeenCalled();
  });
});
