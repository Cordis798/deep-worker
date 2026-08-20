import fs from 'node:fs/promises';
import path from 'node:path';
import { PiRpcClient, type PiRpcClientOptions } from './rpc-client.js';
import type { PromptAndWaitOptions } from './rpc-client.js';
import type { RpcEvent } from './rpc-types.js';

export interface SessionStateLike {
  sessionId: string;
  sessionFile?: string;
  [key: string]: unknown;
}

export interface SessionClient {
  start(): Promise<void>;
  close(): Promise<void>;
  getState(): Promise<SessionStateLike>;
  promptAndWait?(message: string, options?: PromptAndWaitOptions): Promise<RpcEvent[]>;
  getLastAssistantText?(): Promise<string | null>;
}

export interface SessionConfig {
  sessionId: string;
  cwd?: string;
  sessionDir?: string;
  sessionFile?: string;
  identityHash?: string;
  capabilityHash?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PiSessionManagerOptions {
  baseDir: string;
  idleTimeoutMs?: number;
  ensureDirectories?: boolean;
  createClient?: (options: PiRpcClientOptions) => SessionClient;
}

interface ManagedSession {
  client: SessionClient;
  identityHash?: string;
  capabilityHash?: string;
  lastUsedAt: number;
  inUse: number;
}

/** 为每个运行时会话管理独立且可持久化的 Pi 进程。 */
export class PiSessionManager {
  private readonly options: Required<
    Pick<PiSessionManagerOptions, 'idleTimeoutMs' | 'ensureDirectories'>
  > &
    PiSessionManagerOptions;
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(options: PiSessionManagerOptions) {
    this.options = {
      idleTimeoutMs: 30 * 60_000,
      ensureDirectories: true,
      ...options,
    };
  }

  async getOrCreate(config: SessionConfig): Promise<SessionClient> {
    const existing = this.sessions.get(config.sessionId);
    if (
      existing &&
      existing.identityHash === config.identityHash &&
      existing.capabilityHash === config.capabilityHash
    ) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }
    if (existing) {
      await existing.client.close();
      this.sessions.delete(config.sessionId);
    }
    const sessionRoot = path.join(this.options.baseDir, config.sessionId);
    const cwd = config.cwd ?? path.join(sessionRoot, 'workspace');
    const sessionDir = config.sessionDir ?? path.join(sessionRoot, 'sessions');
    if (this.options.ensureDirectories) {
      await fs.mkdir(cwd, { recursive: true });
      await fs.mkdir(sessionDir, { recursive: true });
    }
    const client = (
      this.options.createClient ?? ((clientOptions) => new PiRpcClient(clientOptions))
    )({
      cwd,
      sessionDir,
      sessionFile: config.sessionFile,
      env: config.env,
      tools: ['bash'],
    });
    try {
      await client.start();
      await client.getState();
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.sessions.set(config.sessionId, {
      client,
      identityHash: config.identityHash,
      capabilityHash: config.capabilityHash,
      lastUsedAt: Date.now(),
      inUse: 0,
    });
    return client;
  }

  async withSession<T>(
    config: SessionConfig,
    fn: (client: SessionClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.getOrCreate(config);
    const entry = this.sessions.get(config.sessionId)!;
    entry.inUse += 1;
    try {
      return await fn(client);
    } finally {
      entry.inUse -= 1;
      entry.lastUsedAt = Date.now();
    }
  }

  async sweepIdle(now = Date.now()): Promise<void> {
    for (const [sessionId, entry] of this.sessions) {
      if (entry.inUse === 0 && now - entry.lastUsedAt >= this.options.idleTimeoutMs) {
        await entry.client.close();
        this.sessions.delete(sessionId);
      }
    }
  }

  async invalidate(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    await entry.client.close();
  }

  async closeAll(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(entries.map((entry) => entry.client.close()));
  }

  size(): number {
    return this.sessions.size;
  }
}
