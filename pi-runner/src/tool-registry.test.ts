import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry.js';

describe('ToolRegistry', () => {
  it('provides a registerTool-compatible skeleton without claiming structured semantics', () => {
    const registry = new ToolRegistry();
    registry.registerTool({
      name: 'future_read',
      description: 'Reserved for a future Pi extension tool.',
    });
    expect(registry.list()).toEqual([
      { name: 'future_read', description: 'Reserved for a future Pi extension tool.' },
    ]);
    expect(() => registry.registerTool({ name: 'future_read', description: 'duplicate' })).toThrow(
      /already registered/i,
    );
  });
});
