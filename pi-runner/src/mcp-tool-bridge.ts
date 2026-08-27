import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { PiMcpServer } from './capability-injection.js';

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpTransport {
  connect(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export class McpToolBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'McpToolBridgeError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpToolBridgeError('MCP_RESPONSE_INVALID', 'MCP 响应不是对象');
  }
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeToolName(value: string): string {
  const normalized = value.replaceAll(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return normalized || crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function jsonSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'object', properties: {} };
  }
  const schema = value as Record<string, unknown>;
  return { type: 'object', ...schema };
}

function textContent(value: unknown): Array<{ type: 'text'; text: string }> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  if (source?.isError === true) throw new McpToolBridgeError('MCP_TOOL_FAILED', 'MCP 工具执行失败');
  if (Array.isArray(source?.content)) {
    const content = source.content.map((item) => {
      const block = item && typeof item === 'object' ? item as Record<string, unknown> : undefined;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      if (block?.type === 'image') return '[MCP 返回了图片内容]';
      return JSON.stringify(item);
    });
    return [{ type: 'text', text: content.join('\n').slice(0, 100_000) }];
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [{ type: 'text', text: (text ?? '').slice(0, 100_000) }];
}

class JsonRpcMcpClient {
  private connected = false;

  constructor(private readonly transport: McpTransport) {}

  async connect(): Promise<void> {
    try {
      await this.transport.connect();
      await this.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'deep-worker', version: '0.1.0' },
      }, true);
      this.connected = true;
    } catch (error) {
      await this.transport.close().catch(() => undefined);
      throw new McpToolBridgeError('MCP_CONNECT_FAILED', errorMessage(error));
    }
  }

  async listTools(): Promise<McpTool[]> {
    const result = record(await this.request('tools/list'));
    if (!Array.isArray(result.tools)) throw new McpToolBridgeError('MCP_RESPONSE_INVALID', 'tools/list 缺少 tools 数组');
    return result.tools.map((tool) => {
      const item = record(tool);
      if (typeof item.name !== 'string' || !item.name.trim()) throw new McpToolBridgeError('MCP_RESPONSE_INVALID', 'MCP 工具缺少名称');
      return {
        name: item.name,
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(item.inputSchema !== undefined ? { inputSchema: item.inputSchema } : {}),
      };
    });
  }

  async callTool(name: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new McpToolBridgeError('MCP_TOOL_ABORTED', 'MCP 工具执行已取消');
    const request = this.request('tools/call', { name, arguments: argumentsValue });
    if (!signal) return request;
    let abortHandler: (() => void) | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          abortHandler = () => reject(new McpToolBridgeError('MCP_TOOL_ABORTED', 'MCP 工具执行已取消'));
          signal.addEventListener('abort', abortHandler, { once: true });
        }),
      ]);
    } finally {
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    await this.transport.close();
  }

  private async request(method: string, params?: unknown, allowBeforeInitialize = false): Promise<unknown> {
    if (!this.connected && !allowBeforeInitialize) throw new McpToolBridgeError('MCP_NOT_CONNECTED', 'MCP 客户端尚未连接');
    try {
      const response = record(await this.transport.request(method, params));
      if (response.error) throw new McpToolBridgeError('MCP_REQUEST_FAILED', `MCP 请求失败：${method}`);
      return response.result ?? response;
    } catch (error) {
      if (error instanceof McpToolBridgeError) throw error;
      throw new McpToolBridgeError('MCP_REQUEST_FAILED', errorMessage(error));
    }
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class StdioMcpTransport implements McpTransport {
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly options: { command: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; requestTimeoutMs?: number }) {}

  async connect(): Promise<void> {
    if (this.process) return;
    this.process = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.handleData(chunk));
    this.process.on('error', (error) => this.rejectAll(error));
    this.process.on('exit', () => this.rejectAll(new Error('MCP stdio 进程已退出')));
    await Promise.resolve();
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.process?.stdin.writable) return Promise.reject(new McpToolBridgeError('MCP_NOT_CONNECTED', 'MCP stdio 未连接'));
    const id = ++this.nextId;
    const request = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpToolBridgeError('MCP_REQUEST_TIMEOUT', `MCP 请求超时：${method}`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(request);
    });
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.rejectAll(new Error('MCP stdio 已关闭'));
    if (!child) return;
    if (child.exitCode !== null) return;
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line) continue;
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof message.id !== 'number') continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      } catch {
        this.rejectAll(new Error('MCP stdio 返回了无效 JSON'));
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class HttpMcpTransport implements McpTransport {
  private nextId = 0;
  private connected = false;

  constructor(private readonly options: { url: string; headers?: Record<string, string>; requestTimeoutMs?: number }) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.connected) throw new McpToolBridgeError('MCP_NOT_CONNECTED', 'MCP HTTP 未连接');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 30_000);
    try {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.options.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.nextId, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new McpToolBridgeError('MCP_REQUEST_FAILED', `MCP HTTP 请求失败：${response.status}`);
      return response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new McpToolBridgeError('MCP_REQUEST_TIMEOUT', `MCP 请求超时：${method}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}

function createTransport(server: PiMcpServer): McpTransport {
  const credentials = Object.fromEntries(Object.entries(server.credentials ?? {}).map(([key, value]) => [key, String(value)]));
  if (server.transport === 'stdio') {
    if (!server.command) throw new McpToolBridgeError('MCP_CONFIG_INVALID', `stdio MCP 缺少 command：${server.name}`);
    return new StdioMcpTransport({ command: server.command, args: server.args, cwd: server.cwd, env: credentials });
  }
  if (!server.url) throw new McpToolBridgeError('MCP_CONFIG_INVALID', `HTTP MCP 缺少 url：${server.name}`);
  return new HttpMcpTransport({
    url: server.url,
    headers: {
      ...server.headers,
      ...Object.fromEntries(Object.entries(credentials).map(([key, value]) => [`x-mcp-${key}`, value])),
    },
  });
}

export interface McpToolBridge {
  tools: ToolDefinition[];
  close(): Promise<void>;
}

export async function createMcpToolBridge(servers: readonly PiMcpServer[]): Promise<McpToolBridge | undefined> {
  if (servers.length === 0) return undefined;
  const clients: Array<{ client: JsonRpcMcpClient; server: PiMcpServer }> = [];
  const definitions: ToolDefinition[] = [];
  const usedNames = new Set<string>();
  try {
    for (const server of servers) {
      const client = new JsonRpcMcpClient(createTransport(server));
      await client.connect();
      clients.push({ client, server });
      for (const tool of await client.listTools()) {
        const baseName = `mcp_${safeToolName(server.name)}_${safeToolName(tool.name)}`;
        let name = baseName;
        if (usedNames.has(name)) name = `${baseName}_${crypto.createHash('sha256').update(`${server.id}:${tool.name}`).digest('hex').slice(0, 8)}`;
        usedNames.add(name);
        definitions.push({
          name,
          label: `MCP · ${server.name}/${tool.name}`,
          description: tool.description ?? `调用 ${server.name} 提供的 ${tool.name} 工具`,
          promptSnippet: `MCP 工具：${server.name}/${tool.name}`,
          parameters: jsonSchema(tool.inputSchema) as never,
          executionMode: 'sequential',
          execute: async (
            _toolCallId: string,
            params: Record<string, unknown>,
            signal: AbortSignal | undefined,
            _onUpdate: AgentToolUpdateCallback | undefined,
            _ctx: ExtensionContext,
          ): Promise<AgentToolResult<unknown>> => ({
            content: textContent(await client.callTool(tool.name, params, signal)),
            details: { serverId: server.id, serverName: server.name, toolName: tool.name },
          }),
        });
      }
    }
  } catch (error) {
    await Promise.all(clients.map(({ client }) => client.close().catch(() => undefined)));
    throw error;
  }
  return {
    tools: definitions,
    close: async () => {
      await Promise.all(clients.map(({ client }) => client.close().catch(() => undefined)));
    },
  };
}
