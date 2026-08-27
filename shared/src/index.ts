/**
 * server、web 与 pi-runner 共用的类型定义。
 *
 * 三个子项目通过这里共享流式事件协议，避免各自维护不一致的数据结构。
 */
export const SHARED_PACKAGE_VERSION = '0.1.0';

export interface VersionInfo {
  package: string;
  version: string;
}

export type {
  StreamAgentScope,
  StreamDisplayLevel,
  StreamEvent,
  StreamEventType,
  StreamUsage,
} from './stream-event.js';

export type {
  AgentRouterCandidate,
  AgentRouterPlanSpec,
  AgentRouterPlanStatus,
  AgentRouterResult,
  AgentRouterTaskResult,
  AgentRouterTaskSpec,
  AgentRouterTaskStatus,
} from './agent-router.js';
