import { describe, expect, it } from 'vitest';
import { isCapabilityAllowed, resolveCapabilityGovernance } from './capability-governance.js';

describe('capability governance', () => {
  it('maps job roles to explicit capability packages', () => {
    const engineering = resolveCapabilityGovernance({ jobRole: 'engineering' });
    expect(engineering.packageId).toBe('engineering');
    expect(isCapabilityAllowed(engineering, 'skill', 'git')).toBe(true);
    expect(isCapabilityAllowed(engineering, 'mcp', 'crm')).toBe(false);
    expect(engineering.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed for unknown roles and resolves deny conflicts deterministically', () => {
    const general = resolveCapabilityGovernance({
      jobRole: 'unknown',
      deny: { skill: ['git'] },
    });
    expect(general.jobRole).toBe('general');
    expect(isCapabilityAllowed(general, 'skill', 'git')).toBe(false);
    expect(general.conflicts).toEqual(['skill:git']);
  });
});
