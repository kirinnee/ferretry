import { homePortAccepted, homePortAcceptedPath } from '@ferretry/kernel/contract/home-port';
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

/**
 * The port this home's configuration has IN EFFECT, from the record the daemon keeps of what it put into effect: never
 * the text on disk, which may be an edit still held for the owner. `undefined` when it names none (or nothing is
 * accepted yet): a client with nothing to dial falls back to the well-known address.
 */
export async function readHomePort(home: string): Promise<number | undefined> {
  const outcome = homePortAccepted(await readDaemonRunDocument(homePortAcceptedPath(home)));
  return outcome.kind === 'port' ? outcome.port : undefined;
}
