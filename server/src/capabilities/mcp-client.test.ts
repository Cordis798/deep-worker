import { afterEach, describe, expect, it } from 'vitest';
import { McpClient, InMemoryMcpTransport, type McpTool } from './mcp-client.js';

describe('最小 MCP 客户端', () => {
  let transport: InMemoryMcpTransport;

  afterEach(() => transport?.close());

  it('完成连接、工具列表和工具调用闭环', async () => {
    const tool: McpTool = { name: 'echo', description: '回显', inputSchema: { type: 'object' } };
    transport = new InMemoryMcpTransport({
      tools: [tool],
      call: async (name, args) => ({ content: [{ type: 'text', text: `${name}:${String((args as { value?: unknown }).value)}` }] }),
    });
    const client = new McpClient(transport);
    await client.connect();
    await expect(client.healthCheck()).resolves.toBe(true);
    await expect(client.listTools()).resolves.toEqual([tool]);
    await expect(client.callTool('echo', { value: 'ok' })).resolves.toEqual({ content: [{ type: 'text', text: 'echo:ok' }] });
  });

  it('拒绝未连接和 MCP 错误响应', async () => {
    transport = new InMemoryMcpTransport({ tools: [], errorMethod: 'tools/list' });
    const client = new McpClient(transport);
    await expect(client.listTools()).rejects.toMatchObject({ code: 'MCP_NOT_CONNECTED' });
    await client.connect();
    await expect(client.listTools()).rejects.toMatchObject({ code: 'MCP_REQUEST_FAILED' });
  });
});
