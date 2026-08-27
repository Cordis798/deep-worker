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
    expect(requests.map((request) => request.method)).toEqual(['initialize', 'tools/list', 'tools/call']);
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
});
