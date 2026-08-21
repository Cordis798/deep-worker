import type { StreamEvent } from '@deep-worker/shared';
import { create } from 'zustand';
import { api, getErrorMessage } from '../api/client.js';
import { openTurnStream } from '../api/ws.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinking: string;
  events: StreamEvent[];
  status: 'streaming' | 'complete' | 'error' | 'stopped';
  createdAt: string;
}

export const EMPTY_MESSAGES: ChatMessage[] = [];

export function selectSessionMessages(
  state: Pick<ChatState, 'messages'>,
  sessionId: string | null,
) {
  return sessionId ? (state.messages[sessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
}

interface ActiveTurn {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  close: () => void;
}

interface ChatState {
  messages: Record<string, ChatMessage[]>;
  activeTurns: Record<string, ActiveTurn>;
  sendError: Record<string, string | null>;
  sendMessage: (workspaceId: string, sessionId: string, text: string) => Promise<void>;
  stopMessage: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
}

function messageKey(sessionId: string) {
  return sessionId;
}

function updateAssistant(
  messages: ChatMessage[],
  assistantId: string,
  updater: (message: ChatMessage) => ChatMessage,
) {
  return messages.map((message) => (message.id === assistantId ? updater(message) : message));
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: {},
  activeTurns: {},
  sendError: {},

  sendMessage: async (workspaceId, sessionId, text) => {
    const content = text.trim();
    if (!content || get().activeTurns[sessionId]) return;
    const userId = `user-${crypto.randomUUID()}`;
    const assistantId = `assistant-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: userId,
      role: 'user',
      text: content,
      thinking: '',
      events: [],
      status: 'complete',
      createdAt: now,
    };
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      text: '',
      thinking: '',
      events: [],
      status: 'streaming',
      createdAt: now,
    };
    set((state) => ({
      messages: {
        ...state.messages,
        [messageKey(sessionId)]: [
          ...(state.messages[messageKey(sessionId)] ?? []),
          userMessage,
          assistantMessage,
        ],
      },
      sendError: { ...state.sendError, [sessionId]: null },
    }));

    try {
      const response = await api.post<{ turn: { id: string } }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-sessions/${encodeURIComponent(sessionId)}/messages/stream`,
        { message: content, idempotency_key: `${sessionId}:${crypto.randomUUID()}` },
      );
      let terminal = false;
      let streamClosed = false;
      let stream: ReturnType<typeof openTurnStream> | null = null;
      stream = openTurnStream(workspaceId, sessionId, response.turn.id, {
        onEvent: (event) => {
          let failureMessage: string | null = null;
          set((state) => {
            const current = state.messages[messageKey(sessionId)] ?? [];
            const next = updateAssistant(current, assistantId, (message) => {
              const isFailure =
                event.eventType === 'status' && event.statusText === 'agent failed';
              const isTerminal =
                event.eventType === 'status' &&
                (event.statusText === 'agent settled' || event.statusText === 'agent failed');
              if (isTerminal) terminal = true;
              if (isFailure) {
                failureMessage = event.detail ?? event.summary ?? 'Pi Agent 执行失败';
              }
              return {
                ...message,
                text:
                  event.eventType === 'text_delta'
                    ? `${message.text}${event.text ?? ''}`
                    : message.text,
                thinking:
                  event.eventType === 'thinking_delta'
                    ? `${message.thinking}${event.text ?? ''}`
                    : message.thinking,
                events: [...message.events, event],
                status: isFailure ? 'error' : isTerminal ? 'complete' : message.status,
              };
            });
            return {
              messages: { ...state.messages, [messageKey(sessionId)]: next },
              sendError: failureMessage
                ? { ...state.sendError, [sessionId]: failureMessage }
                : state.sendError,
            };
          });
          if (terminal) {
            stream?.close();
            set((state) => {
              const nextTurns = { ...state.activeTurns };
              delete nextTurns[sessionId];
              return { activeTurns: nextTurns };
            });
          }
        },
        onError: () => {
          set((state) => ({
            sendError: { ...state.sendError, [sessionId]: '聊天连接失败，正在尝试恢复…' },
          }));
        },
        onClose: () => {
          if (terminal) return;
          streamClosed = true;
          set((state) => ({
            messages: {
              ...state.messages,
              [messageKey(sessionId)]: updateAssistant(
                state.messages[messageKey(sessionId)] ?? [],
                assistantId,
                (message) => ({ ...message, status: 'error' }),
              ),
            },
            sendError: { ...state.sendError, [sessionId]: '聊天流已断开，请重试' },
            activeTurns: Object.fromEntries(
              Object.entries(state.activeTurns).filter(([key]) => key !== sessionId),
            ),
          }));
        },
      });
      if (terminal || streamClosed) {
        stream.close();
        return;
      }
      set((state) => ({
        activeTurns: {
          ...state.activeTurns,
          [sessionId]: {
            workspaceId,
            sessionId,
            turnId: response.turn.id,
            close: stream.close,
          },
        },
      }));
    } catch (error) {
      set((state) => ({
        messages: {
          ...state.messages,
          [messageKey(sessionId)]: updateAssistant(
            state.messages[messageKey(sessionId)] ?? [],
            assistantId,
            (message) => ({ ...message, status: 'error' }),
          ),
        },
        sendError: { ...state.sendError, [sessionId]: getErrorMessage(error, '发送失败') },
      }));
    }
  },

  stopMessage: (sessionId) => {
    const active = get().activeTurns[sessionId];
    active?.close();
    set((state) => ({
      messages: {
        ...state.messages,
        [messageKey(sessionId)]: (state.messages[messageKey(sessionId)] ?? []).map((message) =>
          message.status === 'streaming' ? { ...message, status: 'stopped' } : message,
        ),
      },
      activeTurns: Object.fromEntries(
        Object.entries(state.activeTurns).filter(([key]) => key !== sessionId),
      ),
    }));
  },

  clearSession: (sessionId) =>
    set((state) => {
      const messages = { ...state.messages };
      delete messages[messageKey(sessionId)];
      return { messages };
    }),
}));
