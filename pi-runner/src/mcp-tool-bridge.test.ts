import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpToolBridge } from './mcp-tool-bridge.js';

afterEach(() => vi.unstubAllGlobals());

describe('Pi MCP 工具桥接', () => {
  it('发现受治理的 MCP 工具并转发调用结果', async () => {
    const requests: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; params?: Record<string, unknown> };
      requests.push(body);
      if (body.method === 'initialize') return { ok: true, json: async () => ({ result: {} }) };
      if (body.method === 'tools/list') return { ok: true, json: async () => ({ result: { tools: [{ name: 'lookup', description: '查询数据', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }] } }) };
      return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: `value:${String(body.params?.arguments ?? '')}` }] } }) };
    }));

    const bridge = await createMcpToolBridge([{ id: 'mcp-1', name: 'data-api', transport: 'http', url: 'https://example.test', credentials: { token: 'secret' } }]);
    expect(bridge?.tools).toHaveLength(1);
    const tool = bridge!.tools[0] as any;
    expect(tool.name).toBe('mcp_data_api_lookup');
    const result = await tool.execute('call-1', { key: 'id-1' }, undefined, undefined, {});
    expect(result.content[0].text).toContain('value:');
    expect(requests.map((request) => request.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    await bridge!.close();
  });

  it('MCP 工具返回错误时失败关闭', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === 'initialize') return { ok: true, json: async () => ({ result: {} }) };
      if (body.method === 'tools/list') return { ok: true, json: async () => ({ result: { tools: [{ name: 'danger' }] } }) };
      return { ok: true, json: async () => ({ result: { isError: true, content: [{ type: 'text', text: 'denied' }] } }) };
    }));
    const bridge = await createMcpToolBridge([{ id: 'mcp-2', name: 'ops', transport: 'http', url: 'https://example.test' }]);
    await expect((bridge!.tools[0] as any).execute('call-2', {}, undefined, undefined, {})).rejects.toMatchObject({ code: 'MCP_TOOL_FAILED' });
    await bridge!.close();
  });

  it('调用前取消不会发起 MCP 工具请求', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      methods.push(body.method ?? '');
      if (body.method === 'initialize') return { ok: true, json: async () => ({ result: {} }) };
      if (body.method === 'tools/list') return { ok: true, json: async () => ({ result: { tools: [{ name: 'lookup' }] } }) };
      return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: 'unexpected' }] } }) };
    }));
    const bridge = await createMcpToolBridge([{ id: 'mcp-abort-before', name: 'data-api', transport: 'http', url: 'https://example.test' }]);
    const controller = new AbortController();
    controller.abort();
    await expect((bridge!.tools[0] as any).execute('call-abort-before', {}, controller.signal, undefined, {})).rejects.toMatchObject({ code: 'MCP_TOOL_ABORTED' });
    expect(methods).not.toContain('tools/call');
    await bridge!.close();
  });

  it('执行中取消会中止底层 HTTP 请求', async () => {
    let callStarted!: () => void;
    const started = new Promise<void>((resolve) => { callStarted = resolve; });
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === 'initialize') return Promise.resolve({ ok: true, json: async () => ({ result: {} }) });
      if (body.method === 'tools/list') return Promise.resolve({ ok: true, json: async () => ({ result: { tools: [{ name: 'lookup' }] } }) });
      if (body.method !== 'tools/call') return Promise.resolve({ ok: true, json: async () => ({}) });
      observedSignal = init?.signal ?? undefined;
      callStarted();
      return new Promise((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
      });
    }));
    const bridge = await createMcpToolBridge([{ id: 'mcp-abort-during', name: 'data-api', transport: 'http', url: 'https://example.test' }]);
    const controller = new AbortController();
    const pending = (bridge!.tools[0] as any).execute('call-abort-during', {}, controller.signal, undefined, {});
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'MCP_TOOL_ABORTED' });
    expect(observedSignal?.aborted).toBe(true);
    await bridge!.close();
  });

  it('只读工具策略拒绝未声明只读或破坏性 MCP 工具', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === 'initialize') return { ok: true, json: async () => ({ result: {} }) };
      if (body.method === 'tools/list') {
        return {
          ok: true,
          json: async () => ({ result: { tools: [
            { name: 'lookup', annotations: { readOnlyHint: true, destructiveHint: false } },
            { name: 'delete_record', annotations: { readOnlyHint: false, destructiveHint: true } },
            { name: 'unknown' },
          ] } }),
        };
      }
      return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }) };
    }));
    const bridge = await createMcpToolBridge([{ id: 'mcp-read', name: 'data-api', transport: 'http', url: 'https://example.test', toolPolicy: 'read' }]);
    expect(bridge?.tools.map((tool) => tool.name)).toEqual(['mcp_data_api_lookup']);
    await bridge!.close();
  });
});
