import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { materializePiCapabilities } from './capability-injection.js';
import { resolvePiSdkModel, type PiModelRuntimeLike } from './pi-sdk-provider.js';
import { PiSdkRuntimeSession, type PiAgentSessionLike } from './pi-sdk-session.js';
import { discoverPiSessionFile } from './pi-session-discovery.js';
import type {
  AgentRuntime,
  RuntimeSession,
  RuntimeSessionOptions,
} from './runtime.js';

interface SettingsManagerLike {
  setRetryEnabled(enabled: boolean): void;
}

interface ResourceLoaderLike {
  reload(options?: { resolveProjectTrust?: () => Promise<boolean> }): Promise<void>;
}

interface CreateSdkSessionOptions {
  cwd: string;
  agentDir: string;
  modelRuntime: unknown;
  model?: unknown;
  tools: string[];
  resourceLoader: unknown;
  sessionManager: unknown;
  settingsManager: unknown;
}

export interface PiSdkRuntimeDependencies {
  createModelRuntime(options: {
    authPath: string;
    modelsPath: string;
    refreshOnCreate: boolean;
  }): Promise<PiModelRuntimeLike>;
  createSettingsManager(
    cwd: string,
    agentDir: string,
    options: { projectTrusted: boolean },
  ): SettingsManagerLike;
  createResourceLoader(options: {
    cwd: string;
    agentDir: string;
    settingsManager: SettingsManagerLike;
    systemPrompt?: string;
    additionalSkillPaths?: string[];
    noExtensions: boolean;
  }): ResourceLoaderLike;
  createSessionManager(cwd: string, sessionDir: string, options: { id: string }): unknown;
  openSessionManager(file: string, sessionDir: string, cwd: string): unknown;
  createAgentSession(options: CreateSdkSessionOptions): Promise<{
    session: PiAgentSessionLike;
  }>;
}

const defaultDependencies: PiSdkRuntimeDependencies = {
  createModelRuntime: (options) =>
    ModelRuntime.create(options) as unknown as Promise<PiModelRuntimeLike>,
  createSettingsManager: (cwd, agentDir, options) =>
    SettingsManager.create(cwd, agentDir, options),
  createResourceLoader: (options) =>
    new DefaultResourceLoader(
      options as unknown as ConstructorParameters<typeof DefaultResourceLoader>[0],
    ),
  createSessionManager: (cwd, sessionDir, options) =>
    SessionManager.create(cwd, sessionDir, options),
  openSessionManager: (file, sessionDir, cwd) =>
    SessionManager.open(file, sessionDir, cwd),
  createAgentSession: (options) =>
    createAgentSession(
      options as NonNullable<Parameters<typeof createAgentSession>[0]>,
    ) as unknown as Promise<{ session: PiAgentSessionLike }>,
};

export interface PiSdkRuntimeAdapterOptions {
  dependencies?: PiSdkRuntimeDependencies;
}

/** 在当前进程中直接管理 Pi Agent SDK Session，不启动 Pi RPC 子进程。 */
export class PiSdkRuntimeAdapter implements AgentRuntime {
  readonly kind = 'pi' as const;
  private readonly dependencies: PiSdkRuntimeDependencies;
  private readonly sessions = new Set<RuntimeSession>();

  constructor(options: PiSdkRuntimeAdapterOptions = {}) {
    this.dependencies = options.dependencies ?? defaultDependencies;
  }

  async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
    const sessionRoot = path.dirname(options.sessionDir);
    const agentDir = path.join(sessionRoot, 'agent');
    await fs.mkdir(options.cwd, { recursive: true });
    await fs.mkdir(options.sessionDir, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });

    const settingsManager = this.dependencies.createSettingsManager(
      options.cwd,
      agentDir,
      { projectTrusted: true },
    );
    // SessionQueue owns retry policy; disabling nested SDK retries keeps attempts auditable.
    settingsManager.setRetryEnabled(false);
    const modelRuntime = await this.dependencies.createModelRuntime({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    const model = options.provider
      ? await resolvePiSdkModel(modelRuntime, options.provider)
      : undefined;
    const capabilityFiles = options.capabilities
      ? materializePiCapabilities(options.capabilities, sessionRoot)
      : undefined;
    const resourceLoader = this.dependencies.createResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      systemPrompt: options.systemPrompt,
      additionalSkillPaths: capabilityFiles ? [capabilityFiles.skillsDir] : undefined,
      // Extensions execute arbitrary Node code and require a separate approval/sandbox path.
      noExtensions: true,
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => true });

    const discovery = await discoverPiSessionFile(
      options.sessionDir,
      options.sessionId,
      options.sessionFile,
    );
    let sessionManager: unknown;
    if (discovery.status === 'restored') {
      try {
        sessionManager = this.dependencies.openSessionManager(
          discovery.path,
          options.sessionDir,
          options.cwd,
        );
        options.onContextStatus?.({ status: 'restored' });
      } catch {
        options.onContextStatus?.({
          status: 'reset_required',
          reason: 'session_open_failed',
        });
      }
    } else {
      options.onContextStatus?.(discovery);
    }
    sessionManager ??= this.dependencies.createSessionManager(
      options.cwd,
      options.sessionDir,
      { id: options.sessionId },
    );

    const created = await this.dependencies.createAgentSession({
      cwd: options.cwd,
      agentDir,
      modelRuntime,
      ...(model ? { model } : {}),
      tools: options.allowedTools ?? ['bash'],
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    const runtimeSession = new PiSdkRuntimeSession(created.session);
    this.sessions.add(runtimeSession);
    return runtimeSession;
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions];
    this.sessions.clear();
    await Promise.all(sessions.map(async (session) => session.dispose()));
  }
}
