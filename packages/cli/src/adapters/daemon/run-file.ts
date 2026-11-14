import { homePortOf } from '@ferretry/kernel/contract/home-port';
import { readFile } from 'node:fs/promises';
import { homePortPath } from '../../lib/home.ts';

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

/**
 * The port this home's own configuration names for its daemon, or `undefined` when it names none (or the file cannot be
 * read or its port is malformed: the daemon refuses to start on that by sentence, and a client has nothing to dial).
 */
export async function readHomePort(home: string): Promise<number | undefined> {
  const outcome = homePortOf(await readDaemonRunDocument(homePortPath(home)));
  return outcome.kind === 'port' ? outcome.port : undefined;
}
