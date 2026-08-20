export interface ToolRegistration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute?: (...args: unknown[]) => Promise<unknown>;
}

/**
 * 本地 registerTool 兼容边界。
 *
 * 这里只登记工具描述，不实现 Read/Edit/Glob/Grep 的完整语义，后续 Pi 扩展
 * 可以消费这份登记结果。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();

  registerTool(tool: ToolRegistration): void {
    if (!tool.name.trim()) throw new Error('Tool name is required');
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, { ...tool });
  }

  list(): Array<Pick<ToolRegistration, 'name' | 'description'>> {
    return [...this.tools.values()].map(({ name, description }) => ({ name, description }));
  }
}
