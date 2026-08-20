import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializePiCapabilities, type PiCapabilityInjection } from './capability-injection.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Pi 能力注入', () => {
  it('物化隔离 Skill 目录和 settings，并排除凭据字段', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pi-cap-'));
    roots.push(root);
    const skillPath = path.join(root, 'source-skill');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), 'skill');
    const sessionRoot = path.join(root, 'session');
    const manifest: PiCapabilityInjection = {
      hash: 'cap-hash',
      skills: [{ id: 'demo', name: 'demo', path: skillPath, contentHash: 'skill-hash' }],
      mcpServers: [{ id: 'mcp-1', name: 'demo-mcp', transport: 'http', url: 'https://example.test', credentials: { token: 'secret' } }],
      plugins: [{ id: 'plugin-1', name: 'demo-plugin', version: '1.0.0', enabled: true }],
    };
    const result = materializePiCapabilities(manifest, sessionRoot);
    expect(fs.existsSync(path.join(result.skillsDir, 'demo', 'SKILL.md'))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8')) as Record<string, unknown>;
    expect(settings).toMatchObject({ capabilityHash: 'cap-hash', extensions: ['demo-plugin'] });
    expect(JSON.stringify(settings)).not.toContain('secret');
    expect((settings.mcpServers as Record<string, unknown>)['demo-mcp']).toMatchObject({ url: 'https://example.test' });
  });
});
