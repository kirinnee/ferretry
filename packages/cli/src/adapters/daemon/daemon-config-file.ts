import { readFile } from 'node:fs/promises';

/** Not exported: a test substitutes it structurally, and nothing else in this client names it. */
interface DaemonConfigFileSystem {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

const nodeFileSystem: DaemonConfigFileSystem = { readFile };

/**
 * Reads `<FY_HOME>/config/daemon.json`, or reports its absence as `undefined`.
 *
 * THE ONLY DAEMON-OWNED DOCUMENT THIS CLIENT READS, and it reads it for one fact: where the daemon
 * decided to listen. `FY_HOME` is the published contract between the two, so addressing the file
 * through it is following that contract rather than reaching into the daemon's state.
 *
 * EVERY FAILURE IS `undefined`, deliberately, and this is the one place in this repository where
 * swallowing a read error is right: the caller falls back to the well-known default address, which
 * fails visibly as "the daemon is not answering" rather than by refusing to run a command. A client
 * that could not start because it could not read a file it does not own would be strictly worse than
 * one that looked in the usual place.
 */
export async function readDaemonConfigDocument(path: string, fileSystem = nodeFileSystem): Promise<string | undefined> {
  try {
    return await fileSystem.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
