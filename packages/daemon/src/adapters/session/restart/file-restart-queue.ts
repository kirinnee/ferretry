import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RestartQueueEntrySchema, type RestartQueueEntry } from '@ferretry/protocol';
import { z } from 'zod';

/**
 * The restarts waiting for a ferret's next idle moment, in `restarts/queue.json` inside the state home.
 *
 * Durable so a daemon restart does not forget them. It READS AS EMPTY when the file is absent, unreadable
 * or no longer parses: a queued restart is a convenience, never a guarantee, and a forgotten one costs the
 * operator pressing the button again — whereas a daemon that refused to start over it would cost far more.
 * An entry that does not parse is dropped on its own; the rest survive. Written atomically.
 */

export const RESTART_QUEUE_DIRECTORY = 'restarts';
export const RESTART_QUEUE_FILENAME = 'queue.json';

const DocumentSchema = z.object({ queued: z.array(z.unknown()) });

export class FileRestartQueue {
  private readonly path: string;

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, RESTART_QUEUE_DIRECTORY, RESTART_QUEUE_FILENAME);
  }

  async load(): Promise<readonly RestartQueueEntry[]> {
    const raw = await readFile(this.path, 'utf8').catch(() => undefined);
    if (raw === undefined) return [];
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return [];
    }
    const document = DocumentSchema.safeParse(json);
    if (!document.success) return [];
    return document.data.queued.flatMap(candidate => {
      const entry = RestartQueueEntrySchema.safeParse(candidate);
      return entry.success ? [entry.data] : [];
    });
  }

  async save(entries: readonly RestartQueueEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ queued: entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }
}
