/**
 * Shared types across server, web and pi-runner.
 *
 * P1 only stages this package. The stream event protocol shared by all three
 * sub-projects lands with the Pi Runner core loop in P4.
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
