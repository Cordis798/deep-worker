import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContainerRunner, buildContainerArgs } from './container-runner.js';

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
          mounts: [{ hostPath: readonly, containerPath: '/workspace/reference', readonly: true }],
          limits: { memoryMb: 256, cpus: 0.5, pids: 64, tmpfsMb: 32 },
        },
        { image: 'test-image:latest', dockerCommand: 'docker' },
      );
      expect(result.command).toBe('docker');
      expect(result.args).toEqual(expect.arrayContaining([
        '--user', '1000:1000', '--read-only', '--network', 'none',
        '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', 'test-image:latest',
      ]));
      expect(result.args.join(' ')).toContain('dst=/workspace/reference,readonly');
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
      expect(() => buildContainerArgs({ cwd: workspace, sessionDir: session, mounts: [
        { hostPath: workspace, containerPath: '/workspace', readonly: true },
      ] })).toThrow('容器挂载目标重复');
      expect(() => buildContainerArgs({ cwd: workspace, sessionDir: session, mounts: [
        { hostPath: workspace, containerPath: '/workspace/../etc', readonly: true },
      ] })).toThrow('容器挂载路径不安全');
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
    let model: string | undefined;
    let clientOptions: { command?: string; args?: string[] } | undefined;
    const client = {
      start: async () => undefined,
      close: async () => { clientClosed = true; },
      getState: async () => ({ sessionId: 'container-session' }),
      setModel: async (provider: string, modelId: string) => { model = `${provider}/${modelId}`; return {}; },
      getLastAssistantText: async () => '容器回复',
      promptAndWait: async (_message: string, options?: { onEvent?: (event: { type: string }) => void }) => {
        options?.onEvent?.({ type: 'agent_settled' });
        return [{ type: 'agent_settled' }];
      },
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
        provider: { provider: 'openai', modelId: 'test-model', hash: 'provider-hash' },
      });
      expect(result.reply).toBe('容器回复');
      expect(model).toBe('openai/test-model');
      expect(clientOptions?.command).toBe('docker');
      expect(clientOptions?.args).toContain('test-image:latest');
      await runner.close();
      expect(clientClosed).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('超时或 RPC 失败时清理容器会话', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-container-'));
    const workspace = path.join(root, 'workspace');
    const session = path.join(root, 'session');
    fs.mkdirSync(workspace);
    fs.mkdirSync(session);
    let clientClosed = false;
    const client = {
      start: async () => undefined,
      close: async () => { clientClosed = true; },
      getState: async () => ({ sessionId: 'container-session' }),
      promptAndWait: async () => { throw new Error('Pi RPC 超时'); },
    };
    try {
      const runner = new ContainerRunner({ spawnClient: () => client });
      await expect(runner.run({ sessionId: 'failed-session', message: '失败任务', cwd: workspace, sessionDir: session })).rejects.toThrow('Pi RPC 超时');
      expect(clientClosed).toBe(true);
      expect(runner.size()).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
