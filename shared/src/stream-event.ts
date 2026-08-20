/**
 * 运行时无关的轻量流式事件协议。
 *
 * Pi 专用字段保留在 rawEvent 中，下面的字段是 server 与 web 稳定消费的投影。
 */
export type StreamEventType =
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use_start'
  | 'tool_use_end'
  | 'tool_progress'
  | 'tool_result'
  | 'usage'
  | 'status'
  | 'init'
  | 'raw_sdk_event';

export type StreamAgentScope = 'main' | 'task' | 'subagent' | 'system';
export type StreamDisplayLevel = 'primary' | 'detail' | 'debug';

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD?: number;
  durationMs?: number;
}

export interface StreamEvent {
  eventType: StreamEventType;
  agentScope?: StreamAgentScope;
  queryRunId?: string;
  turnId?: string;
  sessionId?: string;
  messageUuid?: string;
  isSynthetic?: boolean;
  displayLevel?: StreamDisplayLevel;
  text?: string;
  summary?: string;
  detail?: string;
  rawType?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  toolInputSummary?: string;
  toolResult?: string;
  usage?: StreamUsage;
  statusText?: string;
  rawEvent?: Record<string, unknown>;
}
