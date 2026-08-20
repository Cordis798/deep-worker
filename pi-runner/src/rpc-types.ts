export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export type RpcCommand =
  | { id?: string; type: 'prompt'; message: string; images?: unknown[]; streamingBehavior?: 'steer' | 'followUp' }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'bash'; command: string; excludeFromContext?: boolean }
  | { id?: string; type: 'abort_bash' }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'get_messages' }
  | { id?: string; type: 'get_last_assistant_text' };

export interface RpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcSessionState {
  model?: Record<string, unknown> | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId: string;
  messageCount?: number;
  pendingMessageCount?: number;
  [key: string]: unknown;
}

export interface RpcBashResult {
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
}
