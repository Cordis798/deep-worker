import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { DATA_DIR } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { getOwnedWorkspace } from '../workspaces.js';
import type { AppVariables } from '../types.js';
import { extractFileText, FileTextError } from '../file-text-extractor.js';
import { TerminalManager } from '../terminal-manager.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

function workspaceRoot(jid: string) {
  const safeJid = jid.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(DATA_DIR, 'workspaces', safeJid);
}

function relativePath(input: string | undefined) {
  const normalized = path.posix.normalize((input ?? '').replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '') return '';
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized === '..' || normalized.startsWith('../')) {
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
  const realRoot = fsSync.existsSync(resolvedRoot)
    ? fsSync.realpathSync(resolvedRoot)
    : resolvedRoot;
  let candidate = resolved;
  while (candidate !== resolvedRoot && candidate !== path.dirname(candidate)) {
    if (fsSync.existsSync(candidate)) {
      const realCandidate = fsSync.realpathSync(candidate);
      if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
        throw new Error('路径不能越过工作区目录');
      }
      break;
    }
    candidate = path.dirname(candidate);
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

export type WorkspaceToolsRoutes = Hono<{ Variables: AppVariables }> & { close: () => Promise<void> };

export function createWorkspaceToolsRoutes(
  db: Parameters<typeof getOwnedWorkspace>[0],
  upgradeWebSocket?: NodeWebSocket['upgradeWebSocket'],
): WorkspaceToolsRoutes {
  const app = new Hono<{ Variables: AppVariables }>();
  const terminals = new TerminalManager();
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
      const root = workspaceRoot(workspace.jid);
      await ensureRoot(root);
      await fs.mkdir(safePath(root, `${parent ? `${parent}/` : ''}${body.name.trim()}`), { recursive: false });
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
      const extracted = await extractFileText(file);
      return c.json({ content: extracted.text, truncated: extracted.truncated, method: extracted.method, path: relative });
    } catch (error) {
      if (error instanceof FileTextError) return c.json({ error: error.message, code: error.code }, error.code === 'unsupported' ? 415 : 400);
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
    return c.json({ sessions: terminals.list(user.id, workspace.jid) });
  });

  app.post('/:jid/terminal-sessions', async (c) => {
    const user = c.get('user')!;
    const workspace = getOwnedWorkspace(db, user.id, c.req.param('jid'));
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    const root = workspaceRoot(workspace.jid);
    await ensureRoot(root);
    const session = terminals.start(user.id, workspace.jid, root);
    return c.json({
      session: {
        id: session.id,
        status: session.status,
        shell: terminals.shellName(),
        mode: session.mode,
        degraded: session.mode !== 'pty',
        ...(session.mode === 'pty' ? {} : { notice: '当前环境不支持原生 PTY，已回退到标准输入输出流。' }),
      },
    }, 201);
  });

  app.delete('/:jid/terminal-sessions/:sessionId', (c) => {
    const user = c.get('user')!;
    const ok = terminals.close(user.id, c.req.param('jid'), c.req.param('sessionId'));
    return ok ? c.json({ success: true }) : c.json({ error: 'Terminal session not found' }, 404);
  });

  if (upgradeWebSocket) {
    app.get('/:jid/terminal-sessions/:sessionId/stream', upgradeWebSocket((c) => {
      const user = c.get('user')!;
      const session = terminals.getForOwner(user.id, c.req.param('jid') ?? '', c.req.param('sessionId') ?? '');
      let unsubscribe: (() => void) | undefined;
      return {
        onOpen: (_event, ws) => {
          if (!session) { ws.close(4404, 'Terminal session not found'); return; }
          const snapshot = terminals.snapshot(session);
          ws.send(JSON.stringify({ type: 'snapshot', data: snapshot.output, status: snapshot.status, mode: snapshot.mode }));
          unsubscribe = terminals.subscribe(session, (message) => ws.send(JSON.stringify(message)));
        },
        onMessage: (event) => {
          if (!session || typeof event.data !== 'string') return;
          try {
            const message = JSON.parse(event.data) as { type?: string; data?: string; cols?: number; rows?: number };
            if (message.type === 'input' && typeof message.data === 'string') terminals.write(session, message.data);
            if (message.type === 'resize' && Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
              terminals.resize(session, message.cols!, message.rows!);
            }
            if (message.type === 'close') terminals.terminate(session);
          } catch {
            // 忽略格式错误的终端消息，不让连接中断。
          }
        },
      onClose: () => { unsubscribe?.(); },
      };
    }));
  }

  return Object.assign(app, {
    close: async () => {
      terminals.closeAll();
    },
  });
}
