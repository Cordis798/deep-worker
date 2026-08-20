import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpTransport {
  connect(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export class McpClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'McpClientError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpClientError('MCP_RESPONSE_INVALID', 'MCP 响应不是对象');
  return value as Record<string, unknown>;
}

export class McpClient {
  private connected = false;

  constructor(private readonly transport: McpTransport) {}

  async connect(): Promise<void> {
    try {
      await this.transport.connect();
      await this.transport.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'deep-worker', version: '0.1.0' } });
      this.connected = true;
    } catch (error) {
      await this.transport.close().catch(() => undefined);
      throw this.asError(error, 'MCP_CONNECT_FAILED');
    }
  }

  async listTools(): Promise<McpTool[]> {
    const result = record(await this.request('tools/list'));
    if (!Array.isArray(result.tools)) throw new McpClientError('MCP_RESPONSE_INVALID', 'tools/list 缺少 tools 数组');
    return result.tools.map((tool) => {
      const item = record(tool);
      if (typeof item.name !== 'string' || !item.name) throw new McpClientError('MCP_RESPONSE_INVALID', 'MCP 工具缺少名称');
      return { name: item.name, ...(typeof item.description === 'string' ? { description: item.description } : {}), ...(item.inputSchema !== undefined ? { inputSchema: item.inputSchema } : {}) };
    });
  }

  async callTool(name: string, argumentsValue: Record<string, unknown> = {}): Promise<unknown> {
    if (!name.trim()) throw new McpClientError('MCP_TOOL_INVALID', '工具名称不能为空');
    return this.request('tools/call', { name, arguments: argumentsValue });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request('ping');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    await this.transport.close();
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.connected && method !== 'initialize') throw new McpClientError('MCP_NOT_CONNECTED', 'MCP 客户端尚未连接');
    try {
      const response = record(await this.transport.request(method, params));
      if (response.error) throw new McpClientError('MCP_REQUEST_FAILED', `MCP 请求失败：${method}`);
      return response.result ?? response;
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      throw this.asError(error, 'MCP_REQUEST_FAILED');
    }
  }

  private asError(error: unknown, code: string): McpClientError {
    return error instanceof McpClientError ? error : new McpClientError(code, error instanceof Error ? error.message : String(error));
  }
}

export interface InMemoryMcpTransportOptions {
  tools: McpTool[];
  call?: (name: string, args: unknown) => unknown | Promise<unknown>;
  errorMethod?: string;
}

export class InMemoryMcpTransport implements McpTransport {
  private connected = false;

  constructor(private readonly options: InMemoryMcpTransportOptions) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.connected) throw new Error('transport is not connected');
    if (method === this.options.errorMethod) return { error: { code: -1, message: 'fake error' } };
    if (method === 'initialize') return { result: { protocolVersion: '2025-03-26' } };
    if (method === 'ping') return { result: {} };
    if (method === 'tools/list') return { result: { tools: this.options.tools } };
    if (method === 'tools/call') {
      const request = params as { name?: string; arguments?: unknown };
      return { result: await this.options.call?.(request.name ?? '', request.arguments) };
    }
    return { result: {} };
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}

export interface StdioMcpTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export class StdioMcpTransport implements McpTransport {
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly options: StdioMcpTransportOptions) {}

  async connect(): Promise<void> {
    if (this.process) return;
    this.process = spawn(this.options.command, this.options.args ?? [], { cwd: this.options.cwd, env: { ...process.env, ...this.options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.handleData(chunk));
    this.process.on('error', (error) => this.rejectAll(error));
    this.process.on('exit', () => this.rejectAll(new Error('MCP stdio 进程已退出')));
    await Promise.resolve();
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.process || !this.process.stdin.writable) return Promise.reject(new McpClientError('MCP_NOT_CONNECTED', 'MCP stdio 未连接'));
    const id = ++this.nextId;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new McpClientError('MCP_REQUEST_TIMEOUT', `MCP 请求超时：${method}`)); }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(request);
    });
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.rejectAll(new Error('MCP stdio 已关闭'));
    if (!child) return;
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

export interface HttpMcpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class HttpMcpTransport implements McpTransport {
  private nextId = 0;
  private connected = false;

  constructor(private readonly options: HttpMcpTransportOptions) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.connected) throw new McpClientError('MCP_NOT_CONNECTED', 'MCP HTTP 未连接');
    const response = await (this.options.fetchImpl ?? fetch)(this.options.url, { method: 'POST', headers: { 'content-type': 'application/json', ...this.options.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.nextId, method, params }) });
    if (!response.ok) throw new McpClientError('MCP_REQUEST_FAILED', `MCP HTTP 请求失败：${response.status}`);
    return response.json() as Promise<unknown>;
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}
