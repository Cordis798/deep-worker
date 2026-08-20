import type { StreamEvent } from '@deep-worker/shared';

export interface TurnStreamHandlers {
  onEvent: (event: StreamEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
}

export function openTurnStream(
  workspaceId: string,
  sessionId: string,
  turnId: string,
  handlers: TurnStreamHandlers,
) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`;
  const socket = new WebSocket(`${protocol}//${window.location.host}${path}`);
  let closed = false;

  socket.onopen = () => handlers.onOpen?.();
  socket.onmessage = (message) => {
    try {
      const event = JSON.parse(String(message.data)) as StreamEvent;
      if (event && typeof event.eventType === 'string') handlers.onEvent(event);
    } catch {
      handlers.onError?.();
    }
  };
  socket.onerror = () => handlers.onError?.();
  socket.onclose = () => {
    if (!closed) handlers.onClose?.();
  };

  return {
    close: () => {
      closed = true;
      socket.close();
    },
  };
}
