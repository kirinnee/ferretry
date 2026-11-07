import { readFile } from 'node:fs/promises';

/**
 * Reads the daemon's run record (`<home>/run/daemon.json`), or `undefined` when it is absent or unreadable.
 * Swallowing the error is right here: the caller falls back to the well-known address, which fails visibly as "the
 * daemon is not answering" instead of refusing to run a command over a file this client does not own.
 */
export async function readDaemonRunDocument(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
