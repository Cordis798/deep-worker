import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

export interface TerminalSession {
  id: string;
  ownerUserId: string;
  workspaceJid: string;
  process: ChildProcessWithoutNullStreams;
  output: string;
  status: 'running' | 'exited' | 'failed';
  listeners: Set<(message: unknown) => void>;
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  start(ownerUserId: string, workspaceJid: string, cwd: string): TerminalSession {
    const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh');
    const child = spawn(shell, [], { cwd, env: process.env, stdio: 'pipe' });
    const session: TerminalSession = {
      id: `term_${crypto.randomUUID()}`,
      ownerUserId,
      workspaceJid,
      process: child,
      output: '',
      status: 'running',
      listeners: new Set(),
    };
    const publish = (message: unknown) => session.listeners.forEach((listener) => listener(message));
    const append = (data: Buffer) => {
      const text = data.toString('utf8');
      session.output = `${session.output}${text}`.slice(-200_000);
      publish({ type: 'output', data: text });
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      session.status = 'failed';
      publish({ type: 'status', status: 'failed', error: error.message });
    });
    child.on('exit', (code) => {
      session.status = 'exited';
      publish({ type: 'status', status: 'exited', code });
    });
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
      .map((session) => ({ id: session.id, status: session.status, degraded: true }));
  }

  subscribe(session: TerminalSession, listener: (message: unknown) => void): () => void {
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  write(session: TerminalSession, data: string): void {
    if (session.status === 'running' && session.process.stdin.writable) session.process.stdin.write(data);
  }

  close(ownerUserId: string, workspaceJid: string, id: string): boolean {
    const session = this.getForOwner(ownerUserId, workspaceJid, id);
    if (!session) return false;
    session.process.kill();
    this.sessions.delete(id);
    return true;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.process.kill();
    this.sessions.clear();
  }

  snapshot(session: TerminalSession): { output: string; status: TerminalSession['status'] } {
    return { output: session.output, status: session.status };
  }

  shellName(): string {
    return path.basename(process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh'));
  }
}
