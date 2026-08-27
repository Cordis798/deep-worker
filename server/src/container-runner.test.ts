import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContainerRunner, buildContainerArgs, type ContainerWorkerClient } from './container-runner.js';

describe('容器运行器', () => {
  it('生成非 root、只读根文件系统、资源限制和显式挂载参数', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-container-'));
    const workspace = path.join(root, 'workspace');
    const session = path.join(root, 'session');
    const readonly = path.join(root, 'readonly');
    fs.mkdirSync(workspace);
    fs.mkdirSync(session);
    fs.mkdirSync(readonly);
    try {
      const result = buildContainerArgs(
        {
          cwd: workspace,
          sessionDir: session,
          mounts: [
            { hostPath: readonly, containerPath: '/workspace/reference', readonly: true },
          ],
          limits: { memoryMb: 256, cpus: 0.5, pids: 64, tmpfsMb: 32 },
        },
        { image: 'test-image:latest', dockerCommand: 'docker' },
      );
      expect(result.command).toBe('docker');
      expect(result.args.slice(0, 4)).toEqual(['run', '--rm', '--interactive', '--init']);
      expect(result.args).toEqual(
        expect.arrayContaining([
          '--user',
          '1000:1000',
          '--read-only',
          '--network',
          'bridge',
          '--memory',
          '256m',
          '--cpus',
          '0.5',
          '--pids-limit',
          '64',
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,size=32m',
          'test-image:latest',
        ]),
      );
      expect(result.args.join(' ')).toContain('dst=/workspace/reference,readonly');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('允许镜像使用显式的中性 SDK Worker 入口', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-container-entrypoint-'));
    const workspace = path.join(root, 'workspace');
    const session = path.join(root, 'session');
    fs.mkdirSync(workspace);
    fs.mkdirSync(session);
    try {
      const result = buildContainerArgs(
        { cwd: workspace, sessionDir: session },
        {
          image: 'test-image:latest',
          dockerCommand: 'docker',
          entrypoint: ['node', '/app/pi-runner/dist/pi-sdk-worker.js'],
        },
      );
      expect(result.args.slice(-3)).toEqual([
        'test-image:latest',
        'node',
        '/app/pi-runner/dist/pi-sdk-worker.js',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('拒绝重复目标和危险容器路径', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-container-'));
    const workspace = path.join(root, 'workspace');
    const session = path.join(root, 'session');
    fs.mkdirSync(workspace);
    fs.mkdirSync(session);
    try {
      expect(() =>
        buildContainerArgs({
          cwd: workspace,
          sessionDir: session,
          mounts: [{ hostPath: workspace, containerPath: '/workspace', readonly: true }],
        }),
      ).toThrow('容器挂载目标重复');
      expect(() =>
        buildContainerArgs({
          cwd: workspace,
          sessionDir: session,
          mounts: [{ hostPath: workspace, containerPath: '/workspace/../etc', readonly: true }],
        }),
      ).toThrow('容器挂载路径不安全');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('通过注入的客户端执行并关闭容器，不回退到 Host', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-container-'));
    const workspace = path.join(root, 'workspace');
    const session = path.join(root, 'session');
    fs.mkdirSync(workspace);
    fs.mkdirSync(session);
    let clientClosed = false;
    let clientOptions:
      { command?: string; commandPrefixArgs?: string[]; env?: NodeJS.ProcessEnv; runtimeOptions?: { provider?: { env?: NodeJS.ProcessEnv } } } | undefined;
    const listeners = new Set<(event: any) => void>();
    const client: ContainerWorkerClient = {
      sessionId: 'container-session',
      isStreaming: false,
      start: async () => undefined,
      close: async () => {
        clientClosed = true;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt: async () => {
        for (const listener of listeners) {
          listener({ type: 'text_delta', sessionId: 'container-session', delta: '容器' });
        }
        return {
          text: '容器回复',
          sessionId: 'container-session',
          finalizationReason: 'completed' as const,
        };
      },
      steer: async () => { throw new Error('not used'); },
      followUp: async () => { throw new Error('not used'); },
      abort: async () => undefined,
      compact: async () => undefined,
      dispose: () => undefined,
    };
    try {
      const runner = new ContainerRunner({
        image: 'test-image:latest',
        dockerCommand: 'docker',
        spawnClient: (options) => {
          clientOptions = options;
          return client;
        },
      });
      const result = await runner.run({
        sessionId: 'session-1',
        message: '执行容器任务',
        cwd: workspace,
        sessionDir: session,
        provider: {
          provider: 'openai',
          modelId: 'test-model',
          hash: 'provider-hash',
          env: { OPENAI_API_KEY: 'secret-value' },
          modelConfig: {
            baseUrl: 'https://example.test/v1',
            api: 'openai-completions',
            apiKeyEnv: 'OPENAI_API_KEY',
          },
        },
      });
      expect(result.reply).toBe('容器回复');
      expect(clientOptions?.command).toBe('docker');
      expect(clientOptions?.commandPrefixArgs).toEqual(
        expect.arrayContaining(['run', 'test-image:latest', 'node', '/app/pi-runner/dist/pi-sdk-worker.js']),
      );
      expect(clientOptions?.commandPrefixArgs?.slice(-3)).toEqual([
        'test-image:latest',
        'node',
        '/app/pi-runner/dist/pi-sdk-worker.js',
      ]);
      expect(clientOptions?.commandPrefixArgs).toEqual(
        expect.arrayContaining([
          '--env',
          'OPENAI_API_KEY',
        ]),
      );
      expect(clientOptions?.commandPrefixArgs).not.toContain('secret-value');
      expect(clientOptions?.env).toMatchObject({
        OPENAI_API_KEY: 'secret-value',
      });
      expect(clientOptions?.runtimeOptions?.provider?.env).toBeUndefined();
      await runner.close();
      expect(clientClosed).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('超时或 Worker 失败时清理容器会话', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-container-'));
    const workspace = path.join(root, 'workspace');
    const session = path.join(root, 'session');
    fs.mkdirSync(workspace);
    fs.mkdirSync(session);
    let clientClosed = false;
    const client: ContainerWorkerClient = {
      sessionId: 'container-session',
      isStreaming: false,
      start: async () => undefined,
      close: async () => {
        clientClosed = true;
      },
      subscribe: () => () => undefined,
      prompt: async () => new Promise<never>(() => undefined),
      steer: async () => { throw new Error('not used'); },
      followUp: async () => { throw new Error('not used'); },
      abort: async () => undefined,
      compact: async () => undefined,
      dispose: () => undefined,
    };
    try {
      const runner = new ContainerRunner({ spawnClient: () => client });
      await expect(
        runner.run({
          sessionId: 'failed-session',
          message: '失败任务',
          cwd: workspace,
          sessionDir: session,
          timeoutMs: 5,
        }),
      ).rejects.toThrow('容器 SDK 任务超时');
      expect(clientClosed).toBe(true);
      expect(runner.size()).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
