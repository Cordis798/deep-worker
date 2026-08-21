import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

type TerminalMode = 'pty' | 'pipe';
type TerminalStatus = 'running' | 'exited' | 'failed';

export interface TerminalSession {
  id: string;
  ownerUserId: string;
  workspaceJid: string;
  mode: TerminalMode;
  pty?: IPty;
  process?: ChildProcessWithoutNullStreams;
  output: string;
  status: TerminalStatus;
  listeners: Set<(message: unknown) => void>;
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  start(ownerUserId: string, workspaceJid: string, cwd: string, cols = 120, rows = 32): TerminalSession {
    const session: TerminalSession = {
      id: `term_${crypto.randomUUID()}`,
      ownerUserId,
      workspaceJid,
      mode: 'pipe',
      output: '',
      status: 'running',
      listeners: new Set(),
    };
    const publish = (message: unknown) => session.listeners.forEach((listener) => listener(message));
    const append = (data: string) => {
      session.output = `${session.output}${data}`.slice(-200_000);
      publish({ type: 'output', data });
    };
    const finish = (status: TerminalStatus, code?: number) => {
      if (session.status !== 'running') return;
      session.status = status;
      publish({ type: 'status', status, ...(code === undefined ? {} : { code }) });
    };
    const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh');

    try {
      const terminal = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: Math.max(1, Math.min(400, Math.floor(cols))),
        rows: Math.max(1, Math.min(200, Math.floor(rows))),
        cwd,
        env: process.env,
      });
      session.mode = 'pty';
      session.pty = terminal;
      terminal.onData(append);
      terminal.onExit(({ exitCode }) => finish('exited', exitCode));
    } catch {
      // 原生 PTY 不可用时保留可用的标准输入输出终端，并明确标记为降级模式。
      const child = spawn(shell, [], { cwd, env: process.env, stdio: 'pipe' });
      session.process = child;
      child.stdout.on('data', (data: Buffer) => append(data.toString('utf8')));
      child.stderr.on('data', (data: Buffer) => append(data.toString('utf8')));
      child.on('error', (error) => {
        finish('failed');
        publish({ type: 'status', status: 'failed', error: error.message });
      });
      child.on('exit', (code) => finish('exited', code ?? undefined));
    }
    this.sessions.set(session.id, session);
    return session;
  }

  getForOwner(ownerUserId: string, workspaceJid: string, id: string): TerminalSession | undefined {
    const session = this.sessions.get(id);
    return session && session.ownerUserId === ownerUserId && session.workspaceJid === workspaceJid ? session : undefined;
  }

  list(ownerUserId: string, workspaceJid: string) {
    return [...this.sessions.values()]
      .filter((session) => session.ownerUserId === ownerUserId && session.workspaceJid === workspaceJid)
      .map((session) => ({ id: session.id, status: session.status, mode: session.mode, degraded: session.mode !== 'pty' }));
  }

  subscribe(session: TerminalSession, listener: (message: unknown) => void): () => void {
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  write(session: TerminalSession, data: string): void {
    if (session.status !== 'running') return;
    if (session.mode === 'pty') session.pty?.write(data);
    else if (session.process?.stdin.writable) session.process.stdin.write(data);
  }

  resize(session: TerminalSession, cols: number, rows: number): void {
    if (session.mode !== 'pty' || session.status !== 'running') return;
    session.pty?.resize(Math.max(1, Math.min(400, Math.floor(cols))), Math.max(1, Math.min(200, Math.floor(rows))));
  }

  terminate(session: TerminalSession): void {
    if (session.mode === 'pty') session.pty?.kill();
    else session.process?.kill();
  }

  close(ownerUserId: string, workspaceJid: string, id: string): boolean {
    const session = this.getForOwner(ownerUserId, workspaceJid, id);
    if (!session) return false;
    this.terminate(session);
    this.sessions.delete(id);
    return true;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) this.terminate(session);
    this.sessions.clear();
  }

  snapshot(session: TerminalSession): { output: string; status: TerminalStatus; mode: TerminalMode } {
    return { output: session.output, status: session.status, mode: session.mode };
  }

  shellName(): string {
    return path.basename(process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh'));
  }
}
