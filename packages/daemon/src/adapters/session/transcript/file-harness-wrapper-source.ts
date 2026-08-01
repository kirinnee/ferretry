import { readFile } from 'node:fs/promises';
import type { HarnessWrapperSource } from '../../../lib/session/transcript/index.ts';

/**
 * Reads a fleet wrapper off disk so the daemon can see which harness home it exports.
 *
 * BOUNDED, because the path being read is whatever the fleet manifest published and the daemon has
 * already authorized as a wrapper — but authorization proves it is a launchable fleet executable,
 * not that it is a small text file. A compiled binary published under a wrapper name would
 * otherwise be read into memory in full on every session start.
 *
 * A read that fails is not an error here: a host with no readable script at that path simply
 * supplies no evidence, and the session it belongs to gets no transcript. That is the same answer
 * as an unparseable wrapper and is reported the same way.
 */
export class FileHarnessWrapperSource implements HarnessWrapperSource {
  constructor(private readonly maxBytes = 128 * 1024) {}

  async read(executable: string): Promise<string | undefined> {
    const buffer = await readFile(executable).catch(() => undefined);
    if (buffer === undefined) return undefined;
    const head = buffer.subarray(0, this.maxBytes);
    // A NUL is the cheapest reliable proof of a binary; a shell script never contains one, and
    // decoding one as UTF-8 produces replacement characters a regex could still match against.
    return head.includes(0) ? undefined : head.toString('utf8');
  }
}
