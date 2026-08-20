import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { DATA_DIR } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { getOwnedWorkspace } from '../workspaces.js';
import type { AppVariables } from '../types.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

interface TerminalSession {
  id: string;
  ownerUserId: string;
  workspaceJid: string;
  process: ChildProcessWithoutNullStreams;
  output: string;
  status: 'running' | 'exited' | 'failed';
  listeners: Set<(message: unknown) => void>;
}

function workspaceRoot(jid: string) {
  const safeJid = jid.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(DATA_DIR, 'workspaces', safeJid);
}

function relativePath(input: string | undefined) {
  const normalized = path.posix.normalize((input ?? '').replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '') return '';
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('路径不能越过工作区目录');
  }
  return normalized;
}

function safePath(root: string, relative: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, ...relative.split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('路径不能越过工作区目录');
  }
  return resolved;
}

function decodePath(value: string) {
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
}

async function ensureRoot(root: string) {
  await fs.mkdir(root, { recursive: true });
}

async function listFiles(root: string, currentPath: string) {
  const directory = safePath(root, currentPath);
  await ensureRoot(root);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    const stat = await fs.stat(absolute);
    const relative = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    return {
      name: entry.name,
      path: relative,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: entry.isDirectory() ? 0 : stat.size,
      modifiedAt: stat.mtime.toISOString(),
      isSystem: false,
    };
  }));
  return files.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function findTerminal(
  sessions: Map<string, TerminalSession>,
  db: Parameters<typeof getOwnedWorkspace>[0],
  userId: string,
  jid: string,
  sessionId: string,
) {
  const workspace = getOwnedWorkspace(db, userId, jid);
  const terminal = sessions.get(sessionId);
  if (!workspace || !terminal || terminal.ownerUserId !== userId || terminal.workspaceJid !== jid) return undefined;
  return terminal;
}

export type WorkspaceToolsRoutes = Hono<{ Variables: AppVariables }> & { close: () => Promise<void> };

export function createWorkspaceToolsRoutes(
  db: Parameters<typeof getOwnedWorkspace>[0],
  upgradeWebSocket?: NodeWebSocket['upgradeWebSocket'],
): WorkspaceToolsRoutes {
  const app = new Hono<{ Variables: AppVariables }>();
  const terminals = new Map<string, TerminalSession>();
  app.use('*', authMiddleware(db));

  app.get('/:jid/files', async (c) => {
    const user = c.get('user')!;
    const workspace = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    try {
      const currentPath = relativePath(c.req.query('path'));
      return c.json({ files: await listFiles(workspaceRoot(workspace.jid), currentPath), currentPath });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '无法读取目录' }, 400);
    }
  });

  app.post('/:jid/directories', async (c) => {
    const user = c.get('user')!;
    const workspace = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as { path?: string; name?: string };
    if (!body.name?.trim() || /[\\/]/.test(body.name)) return c.json({ error: '目录名无效' }, 400);
    try {
      const parent = relativePath(body.path);
      await fs.mkdir(safePath(workspaceRoot(workspace.jid), `${parent ? `${parent}/` : ''}${body.name.trim()}`), { recursive: false });
      return c.json({ success: true }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '创建目录失败' }, 400);
    }
  });

  app.post('/:jid/files', async (c) => {
    const user = c.get('user')!;
    const workspace = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    const body = await c.req.parseBody({ all: true });
    const rawFiles = body.files;
    const candidates = Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : [];
    const files = candidates.filter((value): value is File => typeof File !== 'undefined' && value instanceof File);
    if (files.length === 0) return c.json({ error: '没有上传文件' }, 400);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_UPLOAD_BYTES) return c.json({ error: '单次上传不能超过 25MB' }, 413);
    try {
      const currentPath = relativePath(typeof body.path === 'string' ? body.path : undefined);
      const directory = safePath(workspaceRoot(workspace.jid), currentPath);
      await fs.mkdir(directory, { recursive: true });
      for (const file of files) {
        const name = path.basename(file.name.replaceAll('\\', '/'));
        if (!name || name === '.' || name === '..') continue;
        await fs.writeFile(path.join(directory, name), new Uint8Array(await file.arrayBuffer()));
      }
      return c.json({ success: true }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '上传失败' }, 400);
    }
  });

  app.get('/:jid/files/content/:encodedPath', async (c) => {
    const user = c.get('user')!;
    const workspace = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    try {
      const relative = relativePath(decodePath(c.req.param('encodedPath')));
      const file = safePath(workspaceRoot(workspace.jid), relative);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return c.json({ error: '文件不可读取或过大' }, 400);
      return c.json({ content: await fs.readFile(file, 'utf8'), path: relative });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '读取文件失败' }, 404);
    }
  });

  app.put('/:jid/files/content/:encodedPath', async (c) => {
    const user = c.get('user')!;
    const workspace = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as { content?: string };
    if (typeof body.content !== 'string' || Buffer.byteLength(body.content, 'utf8') > MAX_TEXT_BYTES) return c.json({ error: '文件内容无效或过大' }, 400);
    try {
      const relative = relativePath(decodePath(c.req.param('encodedPath')));
      const file = safePath(workspaceRoot(workspace.jid), relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body.content, 'utf8');
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '保存文件失败' }, 400);
    }
  });

  app.delete('/:jid/files/:encodedPath', async (c) => {
    const user = c.get('user')!;
    const workspace = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    try {
      const relative = relativePath(decodePath(c.req.param('encodedPath')));
      await fs.rm(safePath(workspaceRoot(workspace.jid), relative), { recursive: true, force: false });
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '删除文件失败' }, 400);
    }
  });

  app.get('/:jid/files/download/:encodedPath', async (c) => {
    const user = c.get('user')!;
    const workspace = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    try {
      const relative = relativePath(decodePath(c.req.param('encodedPath')));
      const file = safePath(workspaceRoot(workspace.jid), relative);
      const data = new Uint8Array(await fs.readFile(file));
      return new Response(data, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${path.basename(file).replaceAll('"', '')}"`,
        },
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '下载文件失败' }, 404);
    }
  });

  app.get('/:jid/terminal-sessions', (c) => {
    const user = c.get('user')!;
    const workspace = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    return c.json({ sessions: [...terminals.values()].filter((session) => session.ownerUserId === user.id && session.workspaceJid === workspace.jid).map((session) => ({ id: session.id, status: session.status, degraded: true })) });
  });

  app.post('/:jid/terminal-sessions', async (c) => {
    const user = c.get('user')!;
    const workspace = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    const root = workspaceRoot(workspace.jid);
    await ensureRoot(root);
    const id = `term_${crypto.randomUUID()}`;
    const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh');
    const child = spawn(shell, [], { cwd: root, env: process.env, stdio: 'pipe' });
    const session: TerminalSession = { id, ownerUserId: user.id, workspaceJid: workspace.jid, process: child, output: '', status: 'running', listeners: new Set() };
    terminals.set(id, session);
    const publish = (message: unknown) => session.listeners.forEach((listener) => listener(message));
    const appendOutput = (data: Buffer) => {
      session.output = `${session.output}${data.toString('utf8')}`.slice(-200_000);
      publish({ type: 'output', data: data.toString('utf8') });
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.on('error', (error) => { session.status = 'failed'; publish({ type: 'status', status: 'failed', error: error.message }); });
    child.on('exit', (code) => { session.status = 'exited'; publish({ type: 'status', status: 'exited', code }); });
    return c.json({ session: { id, status: session.status, shell: path.basename(shell), degraded: true, notice: '当前使用 Node 子进程流，暂不提供真实 PTY 的窗口大小控制。' } }, 201);
  });

  app.delete('/:jid/terminal-sessions/:sessionId', (c) => {
    const user = c.get('user')!;
    const session = findTerminal(terminals, db, user.id, c.req.param('jid'), c.req.param('sessionId'));
    if (!session) return c.json({ error: 'Terminal session not found' }, 404);
    session.process.kill();
    terminals.delete(session.id);
    return c.json({ success: true });
  });

  if (upgradeWebSocket) {
    app.get('/:jid/terminal-sessions/:sessionId/stream', upgradeWebSocket((c) => {
      const user = c.get('user')!;
      const session = findTerminal(terminals, db, user.id, c.req.param('jid') ?? '', c.req.param('sessionId') ?? '');
      let listener: ((message: unknown) => void) | undefined;
      return {
        onOpen: (_event, ws) => {
          if (!session) { ws.close(4404, 'Terminal session not found'); return; }
          ws.send(JSON.stringify({ type: 'snapshot', data: session.output, status: session.status }));
          listener = (message) => ws.send(JSON.stringify(message));
          session.listeners.add(listener);
        },
        onMessage: (event) => {
          if (!session || typeof event.data !== 'string') return;
          try {
            const message = JSON.parse(event.data) as { type?: string; data?: string };
            if (message.type === 'input' && typeof message.data === 'string' && session.status === 'running') session.process.stdin.write(message.data);
            if (message.type === 'close') session.process.kill();
          } catch {
            // 忽略格式错误的终端消息，不让连接中断。
          }
        },
        onClose: () => { if (session && listener) session.listeners.delete(listener); },
      };
    }));
  }

  return Object.assign(app, {
    close: async () => {
      for (const session of terminals.values()) session.process.kill();
      terminals.clear();
    },
  });
}
