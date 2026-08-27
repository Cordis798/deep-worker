import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentEventListener,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
} from '@deep-worker/pi-runner';
import type { PiSdkWorkerClientOptions, RuntimeSession } from '@deep-worker/pi-runner';
import { PiSdkWorkerClient } from '@deep-worker/pi-runner';
import { assemblePrompt } from '@deep-worker/pi-runner';
import { mapRuntimeEvent } from '@deep-worker/pi-runner';
import { DATA_DIR } from './config.js';

export interface ContainerMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface ContainerLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  tmpfsMb: number;
}

export interface ContainerRunnerOptions {
  image?: string;
  dockerCommand?: string;
  defaultLimits?: Partial<ContainerLimits>;
  spawnClient?: (options: PiSdkWorkerClientOptions) => ContainerWorkerClient;
  validateAdditionalMounts?: (
    ownerUserId: string | undefined,
    mounts: readonly ContainerMount[],
  ) => ContainerMount[];
}

export interface ContainerWorkerClient extends RuntimeSession {
  start(): Promise<void>;
  close(): Promise<void>;
  getStderrTail?(): string;
}

interface ManagedContainerSession {
  client: ContainerWorkerClient;
  providerHash?: string;
  lastUsedAt: number;
}

const DEFAULT_LIMITS: ContainerLimits = {
  memoryMb: 512,
  cpus: 1,
  pids: 128,
  tmpfsMb: 64,
};

function positiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} 必须是正数`);
  return value;
}

function safeHostPath(value: string, field: string): string {
  const resolved = path.resolve(value);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })) throw new Error(`${field} 不存在`);
  return fs.realpathSync(resolved);
}

function safeContainerPath(value: string): string {
  if (!value.startsWith('/') || value.includes('\0'))
    throw new Error('容器挂载路径必须是绝对路径');
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '/' ||
    normalized.startsWith('/proc') ||
    normalized.startsWith('/sys')
  ) {
    throw new Error('容器挂载路径不安全');
  }
  return normalized;
}

export function validateContainerMounts(mounts: readonly ContainerMount[]): ContainerMount[] {
  const seen = new Set<string>();
  return mounts.map((mount) => {
    const hostPath = safeHostPath(mount.hostPath, '挂载源路径');
    const containerPath = safeContainerPath(mount.containerPath);
    if (seen.has(containerPath)) throw new Error(`容器挂载目标重复：${containerPath}`);
    seen.add(containerPath);
    return { hostPath, containerPath, readonly: mount.readonly === true };
  });
}

export function buildContainerArgs(
  request: Pick<AgentRunRequest, 'cwd' | 'sessionDir'> & {
    mounts?: readonly ContainerMount[];
    limits?: Partial<ContainerLimits>;
    envNames?: readonly string[];
  },
  options: Pick<ContainerRunnerOptions, 'image' | 'dockerCommand'> & {
    limits?: Partial<ContainerLimits>;
    entrypoint?: readonly string[];
  } = {},
): { command: string; args: string[]; limits: ContainerLimits } {
  const limits = { ...DEFAULT_LIMITS, ...options.limits, ...request.limits };
  const memoryMb = positiveNumber(limits.memoryMb, '容器内存限制');
  const cpus = positiveNumber(limits.cpus, '容器 CPU 限制');
  const pids = positiveNumber(limits.pids, '容器进程数限制');
  const tmpfsMb = positiveNumber(limits.tmpfsMb, '容器临时目录限制');
  const cwd = safeHostPath(request.cwd ?? process.cwd(), '工作区路径');
  const sessionDir = safeHostPath(
    request.sessionDir ?? path.join(DATA_DIR, 'container-sessions'),
    '会话目录',
  );
  const mounts = validateContainerMounts([
    { hostPath: cwd, containerPath: '/workspace', readonly: false },
    { hostPath: sessionDir, containerPath: '/session', readonly: false },
    ...(request.mounts ?? []),
  ]);
  const args = [
    'run',
    '--rm',
    '--interactive',
    '--init',
    '--user',
    '1000:1000',
    '--read-only',
    '--network',
    'bridge',
    '--memory',
    `${memoryMb}m`,
    '--cpus',
    String(cpus),
    '--pids-limit',
    String(Math.floor(pids)),
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,size=${tmpfsMb}m`,
  ];
  for (const envName of new Set(request.envNames ?? [])) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new Error(`容器环境变量名不安全：${envName}`);
    }
    // 只把变量名交给 Docker，变量值从 Docker 客户端进程环境继承，避免密钥出现在命令参数中。
    args.push('--env', envName);
  }
  for (const mount of mounts) {
    args.push(
      '--mount',
      `type=bind,src=${mount.hostPath},dst=${mount.containerPath}${mount.readonly ? ',readonly' : ''}`,
    );
  }
  args.push(
    options.image ?? process.env.DEEP_WORKER_CONTAINER_IMAGE ?? 'deep-worker-pi:latest',
    ...(options.entrypoint ?? []),
  );
  return {
    command: options.dockerCommand ?? process.env.DEEP_WORKER_DOCKER_COMMAND ?? 'docker',
    args,
    limits: { memoryMb, cpus, pids, tmpfsMb },
  };
}

function providerEnvironment(request: AgentRunRequest): NodeJS.ProcessEnv {
  return { ...process.env, ...(request.provider?.env ?? {}) };
}

/** 通过 Docker 运行容器内的直接 SDK Worker；失败时不会静默降级为 Host。 */
export class ContainerRunner implements AgentRunner {
  private readonly options: Required<Pick<ContainerRunnerOptions, 'image' | 'dockerCommand'>> &
    ContainerRunnerOptions;
  private readonly sessions = new Map<string, ManagedContainerSession>();

  constructor(options: ContainerRunnerOptions = {}) {
    this.options = {
      image:
        options.image ?? process.env.DEEP_WORKER_CONTAINER_IMAGE ?? 'deep-worker-pi:latest',
      dockerCommand:
        options.dockerCommand ?? process.env.DEEP_WORKER_DOCKER_COMMAND ?? 'docker',
      ...options,
    };
  }

  async run(request: AgentRunRequest, onEvent?: AgentEventListener): Promise<AgentRunResult> {
    const session = await this.getOrCreate(request);
    const prompt = assemblePrompt({
      history: request.history,
      currentMessage: request.message,
      outputContract: request.outputContract ?? 'Return the final answer only.',
      capabilities: request.capabilities
        ? {
            hash: request.capabilities.hash,
            skills: request.capabilities.skills.map((skill) => skill.name),
            mcpServers: request.capabilities.mcpServers.map((server) => server.name),
            plugins: request.capabilities.plugins
              .filter((plugin) => plugin.enabled)
              .map((plugin) => plugin.name),
          }
        : undefined,
    });
    const events = [] as AgentRunResult['events'];
    const unsubscribe = session.client.subscribe((runtimeEvent) => {
      for (const event of mapRuntimeEvent(runtimeEvent, {
        sessionId: request.sessionId,
        turnId: request.turnId,
        queryRunId: request.queryRunId,
      })) {
        events.push(event);
        onEvent?.(event);
      }
    });
    try {
      const result = await this.promptWithTimeout(session.client, prompt, request.timeoutMs);
      if (result.finalizationReason === 'error') {
        throw new Error(result.error ?? `容器 SDK 停止：${result.stopReason ?? 'error'}`);
      }
      session.lastUsedAt = Date.now();
      return { sessionId: request.sessionId, reply: result.text, events, attempts: 1 };
    } catch (error) {
      // 超时或 Worker 退出后销毁容器，避免遗留进程继续占用资源。
      this.sessions.delete(request.sessionId);
      await session.client.close().catch(() => undefined);
      throw error;
    } finally {
      unsubscribe();
    }
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((entry) => entry.client.close()));
  }

  size(): number {
    return this.sessions.size;
  }

  private async getOrCreate(request: AgentRunRequest): Promise<ManagedContainerSession> {
    const providerHash = request.provider?.hash;
    const existing = this.sessions.get(request.sessionId);
    if (existing && existing.providerHash === providerHash) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing) {
      await existing.client.close();
      this.sessions.delete(request.sessionId);
    }
    const sessionDir = path.resolve(
      request.sessionDir ?? path.join(DATA_DIR, 'container-sessions', request.sessionId),
    );
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const containerEnv = {
      ...(request.provider?.env ?? {}),
    };
    const additionalMounts =
      request.containerMounts && this.options.validateAdditionalMounts
        ? this.options.validateAdditionalMounts(request.ownerUserId, request.containerMounts)
        : request.containerMounts;
    const built = buildContainerArgs(
      {
        cwd: request.cwd,
        sessionDir,
        mounts: additionalMounts,
        limits: request.containerLimits,
        envNames: Object.keys(containerEnv),
      },
      {
        image: this.options.image,
        dockerCommand: this.options.dockerCommand,
        limits: this.options.defaultLimits,
      },
    );
    const client = (
      this.options.spawnClient ?? ((clientOptions) => new PiSdkWorkerClient(clientOptions))
    )({
      command: built.command,
      commandPrefixArgs: [...built.args, 'node', '/app/pi-runner/dist/pi-sdk-worker.js'],
      cwd: process.cwd(),
      env: {
        ...providerEnvironment(request),
        ...containerEnv,
      },
      runtimeOptions: {
        sessionId: request.sessionId,
        cwd: '/workspace',
        sessionDir: '/session',
        systemPrompt: request.systemPrompt,
        provider: request.provider
          ? { ...request.provider, env: undefined }
          : undefined,
        capabilities: request.capabilities,
        allowedTools: ['bash'],
      },
      requestTimeoutMs: 30_000,
      startupTimeoutMs: 30_000,
    });
    await client.start();
    const managed = { client, providerHash, lastUsedAt: Date.now() };
    this.sessions.set(request.sessionId, managed);
    return managed;
  }

  private async promptWithTimeout(
    client: ContainerWorkerClient,
    prompt: string,
    timeoutMs?: number,
  ) {
    if (!timeoutMs) return client.prompt({ text: prompt });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        client.prompt({ text: prompt }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void client.abort().catch(() => undefined);
            reject(new Error(`容器 SDK 任务超时：${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
