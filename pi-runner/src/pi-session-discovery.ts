import fs from 'node:fs/promises';
import path from 'node:path';

export type PiSessionDiscovery =
  | { status: 'new' }
  | { status: 'restored'; path: string }
  | {
      status: 'reset_required';
      reason:
        | 'ambiguous_session_files'
        | 'invalid_session_file'
        | 'invalid_explicit_session_file';
    };

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readSessionId(file: string): Promise<string | undefined> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    if (!firstLine) return undefined;
    const metadata = JSON.parse(firstLine) as Record<string, unknown>;
    return metadata.type === 'session' && typeof metadata.id === 'string'
      ? metadata.id
      : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

export async function discoverPiSessionFile(
  sessionDir: string,
  expectedSessionId: string,
  explicitSessionFile?: string,
): Promise<PiSessionDiscovery> {
  const resolvedDirectory = path.resolve(sessionDir);
  if (explicitSessionFile) {
    const resolvedFile = path.resolve(explicitSessionFile);
    if (
      path.extname(resolvedFile) !== '.jsonl' ||
      !isWithin(resolvedDirectory, resolvedFile) ||
      !(await readSessionId(resolvedFile))
    ) {
      return { status: 'reset_required', reason: 'invalid_explicit_session_file' };
    }
    return { status: 'restored', path: resolvedFile };
  }

  let entries: string[];
  try {
    entries = (await fs.readdir(resolvedDirectory))
      .filter((entry) => entry.endsWith('.jsonl'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'new' };
    throw error;
  }
  if (entries.length === 0) return { status: 'new' };

  const candidates = (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(resolvedDirectory, entry);
        return { file, id: await readSessionId(file) };
      }),
    )
  ).filter((candidate): candidate is { file: string; id: string } => !!candidate.id);

  if (candidates.length === 1) {
    return { status: 'restored', path: candidates[0].file };
  }
  const exact = candidates.filter((candidate) => candidate.id === expectedSessionId);
  if (exact.length === 1) return { status: 'restored', path: exact[0].file };
  return {
    status: 'reset_required',
    reason: candidates.length === 0 ? 'invalid_session_file' : 'ambiguous_session_files',
  };
}
