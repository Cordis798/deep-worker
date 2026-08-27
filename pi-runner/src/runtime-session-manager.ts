import path from 'node:path';
import type { PiCapabilityInjection } from './capability-injection.js';
import type { PiProviderSelection } from './runner.js';
import type {
  AgentRuntime,
  RuntimeContextStatus,
  RuntimeSession,
} from './runtime.js';

export interface ManagedRuntimeSessionConfig {
  sessionId: string;
  cwd?: string;
  sessionDir?: string;
  sessionFile?: string;
  identityHash?: string;
  capabilityHash?: string;
  providerHash?: string;
  systemPrompt?: string;
  provider?: PiProviderSelection;
  capabilities?: PiCapabilityInjection;
  allowedTools?: string[];
  onContextStatus?: (status: RuntimeContextStatus) => void;
}

export interface RuntimeSessionManagerOptions {
  baseDir: string;
  runtime: AgentRuntime;
  idleTimeoutMs?: number;
}

interface ManagedSession {
  session: RuntimeSession;
  identityHash?: string;
  capabilityHash?: string;
  providerHash?: string;
  lastUsedAt: number;
  inUse: number;
}

export class RuntimeSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: RuntimeSessionManagerOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
  }

  async getOrCreate(config: ManagedRuntimeSessionConfig): Promise<RuntimeSession> {
    const capabilityHash = config.capabilityHash ?? config.capabilities?.hash;
    const existing = this.sessions.get(config.sessionId);
    if (
      existing &&
      existing.identityHash === config.identityHash &&
      existing.capabilityHash === capabilityHash &&
      existing.providerHash === config.providerHash
    ) {
      existing.lastUsedAt = Date.now();
      return existing.session;
    }
    if (existing) {
      this.sessions.delete(config.sessionId);
      await existing.session.dispose();
    }

    const sessionRoot = path.join(this.options.baseDir, config.sessionId);
    const session = await this.options.runtime.createSession({
      sessionId: config.sessionId,
      cwd: config.cwd ?? path.join(sessionRoot, 'workspace'),
      sessionDir: config.sessionDir ?? path.join(sessionRoot, 'sessions'),
      sessionFile: config.sessionFile,
      systemPrompt: config.systemPrompt,
      provider: config.provider,
      capabilities: config.capabilities,
      allowedTools: config.allowedTools,
      onContextStatus: config.onContextStatus,
    });
    this.sessions.set(config.sessionId, {
      session,
      identityHash: config.identityHash,
      capabilityHash,
      providerHash: config.providerHash,
      lastUsedAt: Date.now(),
      inUse: 0,
    });
    return session;
  }

  async withSession<T>(
    config: ManagedRuntimeSessionConfig,
    action: (session: RuntimeSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.getOrCreate(config);
    const managed = this.sessions.get(config.sessionId)!;
    managed.inUse += 1;
    try {
      return await action(session);
    } finally {
      managed.inUse -= 1;
      managed.lastUsedAt = Date.now();
    }
  }

  async invalidate(sessionId: string): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    this.sessions.delete(sessionId);
    await existing.session.dispose();
  }

  async sweepIdle(now = Date.now()): Promise<void> {
    for (const [sessionId, managed] of this.sessions) {
      if (
        managed.inUse === 0 &&
        now - managed.lastUsedAt >= this.idleTimeoutMs
      ) {
        this.sessions.delete(sessionId);
        await managed.session.dispose();
      }
    }
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(async ({ session }) => session.dispose()));
    await this.options.runtime.close();
  }

  size(): number {
    return this.sessions.size;
  }
}
