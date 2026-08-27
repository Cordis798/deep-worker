import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface PiMcpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  credentials?: Record<string, unknown>;
  allowedTools?: string[];
  toolPolicy?: 'read' | 'write';
}

export interface PiCapabilityInjection {
  hash: string;
  skills: Array<{ id: string; name: string; path: string; contentHash: string }>;
  mcpServers: PiMcpServer[];
  plugins: Array<{ id: string; name: string; version: string; enabled: boolean }>;
}

export interface PiCapabilitySettings {
  schemaVersion: 1;
  capabilityHash: string;
  skillsDir: string;
  selectedSkills: string[];
  mcpServers: Record<string, { transport: 'stdio' | 'http'; command?: string; args?: string[]; cwd?: string; url?: string }>;
  extensions: string[];
}

function safeName(value: string): string {
  const normalized = value.replaceAll(/[^A-Za-z0-9._-]/g, '_');
  return normalized || crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function buildPiCapabilitySettings(manifest: PiCapabilityInjection, skillsDir: string): PiCapabilitySettings {
  const mcpServers: PiCapabilitySettings['mcpServers'] = {};
  for (const server of manifest.mcpServers) {
    mcpServers[server.name] = {
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args ? { args: server.args } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.url ? { url: server.url } : {}),
    };
  }
  return {
    schemaVersion: 1,
    capabilityHash: manifest.hash,
    skillsDir,
    selectedSkills: manifest.skills.map((skill) => skill.name).sort(),
    mcpServers,
    extensions: manifest.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.name).sort(),
  };
}

export function materializePiCapabilities(manifest: PiCapabilityInjection, sessionRoot: string): { skillsDir: string; settingsPath: string; settings: PiCapabilitySettings } {
  fs.mkdirSync(sessionRoot, { recursive: true });
  const skillsDir = path.join(sessionRoot, 'skills');
  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  const usedNames = new Set<string>();
  for (const skill of manifest.skills) {
    let targetName = safeName(skill.name);
    if (usedNames.has(targetName)) targetName = `${targetName}-${skill.contentHash.slice(0, 8)}`;
    usedNames.add(targetName);
    if (!fs.existsSync(skill.path)) throw new Error(`Pi Skill 路径不存在：${skill.name}`);
    fs.cpSync(skill.path, path.join(skillsDir, targetName), { recursive: true });
  }
  const settings = buildPiCapabilitySettings(manifest, skillsDir);
  const settingsPath = path.join(sessionRoot, 'pi-settings.json');
  const temporary = `${settingsPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, settingsPath);
  return { skillsDir, settingsPath, settings };
}
