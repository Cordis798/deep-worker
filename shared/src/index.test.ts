import { describe, expect, it } from 'vitest';
import { SHARED_PACKAGE_VERSION, type VersionInfo } from './index.js';

describe('shared scaffold', () => {
  it('exposes a package version and version info type', () => {
    expect(SHARED_PACKAGE_VERSION).toBe('0.1.0');
    const info: VersionInfo = { package: 'shared', version: SHARED_PACKAGE_VERSION };
    expect(info.version).toBe('0.1.0');
  });
});
