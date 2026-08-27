import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverPiSessionFile } from './pi-session-discovery.js';

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deep-worker-pi-session-'));
  roots.push(directory);
  return directory;
}

async function writeSession(directory: string, name: string, id: string): Promise<string> {
  const file = path.join(directory, name);
  await fs.writeFile(file, `${JSON.stringify({ type: 'session', id })}\n`);
  return file;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('discoverPiSessionFile', () => {
  it('restores the only valid JSONL in an isolated directory', async () => {
    const directory = await temporaryDirectory();
    const file = await writeSession(directory, 'legacy.jsonl', 'pi-generated-id');

    await expect(discoverPiSessionFile(directory, 'app-session-id')).resolves.toEqual({
      status: 'restored',
      path: file,
    });
  });

  it('selects an exact metadata id when multiple sessions exist', async () => {
    const directory = await temporaryDirectory();
    await writeSession(directory, 'one.jsonl', 'other');
    const expected = await writeSession(directory, 'two.jsonl', 'app-session-id');

    await expect(discoverPiSessionFile(directory, 'app-session-id')).resolves.toEqual({
      status: 'restored',
      path: expected,
    });
  });

  it('fails closed when multiple files cannot be disambiguated', async () => {
    const directory = await temporaryDirectory();
    await writeSession(directory, 'one.jsonl', 'first');
    await writeSession(directory, 'two.jsonl', 'second');

    await expect(discoverPiSessionFile(directory, 'app-session-id')).resolves.toEqual({
      status: 'reset_required',
      reason: 'ambiguous_session_files',
    });
  });

  it('rejects an explicit session file outside the isolated directory', async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const file = await writeSession(outside, 'outside.jsonl', 'app-session-id');

    await expect(discoverPiSessionFile(directory, 'app-session-id', file)).resolves.toEqual({
      status: 'reset_required',
      reason: 'invalid_explicit_session_file',
    });
  });
});
