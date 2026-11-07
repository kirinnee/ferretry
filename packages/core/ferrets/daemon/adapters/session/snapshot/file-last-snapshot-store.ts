import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  LastSnapshotReader,
  LastSnapshotWriter,
  StoredLastSnapshot,
} from '../../../lib/session/snapshot/index.ts';

/**
 * The one final pane frame an ended session leaves behind.
 *
 * This is daemon-owned durable evidence, not ordinary scratch: scratch GC intentionally preserves
 * it with the state and journal, so an operator can still inspect how a terminal session ended after
 * its disposable files have been reclaimed. A missing file remains missing evidence; this store never
 * manufactures a blank frame for it.
 */
export class FileLastSnapshotStore implements LastSnapshotReader, LastSnapshotWriter {
  constructor(
    private readonly file: (id: string) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  async read(id: string): Promise<StoredLastSnapshot> {
    try {
      return { kind: 'read', text: await readFile(this.file(id), 'utf8') };
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' };
    }
  }

  async write(id: string, text: string): Promise<void> {
    const target = this.file(id);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp.${this.uniqueId()}`;
    try {
      await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
