export interface TerminalStreamHandlers {
  onOutput: (data: string) => void;
  onStatus: (status: string) => void;
  onClose?: () => void;
}

export function openTerminalStream(workspaceId: string, sessionId: string, handlers: TerminalStreamHandlers) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal-sessions/${encodeURIComponent(sessionId)}/stream`;
  const socket = new WebSocket(`${protocol}//${window.location.host}${path}`);
  socket.onmessage = (message) => {
    try {
      const payload = JSON.parse(String(message.data)) as { type?: string; data?: string; status?: string };
      if (payload.type === 'snapshot' || payload.type === 'output') handlers.onOutput(payload.data ?? '');
      if (payload.type === 'status') handlers.onStatus(payload.status ?? 'exited');
    } catch {
      // 忽略无法解析的终端帧，保持终端连接可用。
    }
  };
  socket.onclose = () => handlers.onClose?.();
  return { send: (data: string) => socket.readyState === WebSocket.OPEN && (socket.send(JSON.stringify({ type: 'input', data })), true), close: () => socket.close() };
}
