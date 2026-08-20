export interface ToolRegistration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute?: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Local registerTool-compatible boundary. It deliberately does not implement
 * Read/Edit/Glob/Grep semantics; a future Pi extension can consume this list.
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
