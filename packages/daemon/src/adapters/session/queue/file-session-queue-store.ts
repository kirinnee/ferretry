import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type QueueEvent, QueueEventSchema } from '../../../lib/session/queue/index.ts';
import type { SessionQueueStore } from '../../../lib/session/queue/ports.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/**
 * A session's queue as an append-only log beside it: `channel/queue.jsonl`.
 *
 * DURABLE BEFORE IT ANSWERS. Each event is written and flushed to the disk (`datasync`) before `append`
 * resolves, because "accepted" is a promise the message survives a daemon or a host that goes down a
 * moment later — the promise the owner's withdrawn message did not get.
 *
 * PARSED AT THE BOUNDARY. A line that is not valid JSON, or not an event this daemon knows, is skipped: a
 * torn final line is what a crash mid-append leaves, and one bad line must not hide every message after it.
 * The fold decides what each surviving event may change.
 */
export class FileSessionQueueStore implements SessionQueueStore {
  constructor(private readonly sessionDirectory: (id: SessionId) => string) {}

  file(id: SessionId): string {
    return join(this.sessionDirectory(id), 'channel', 'queue.jsonl');
  }

  async read(id: SessionId): Promise<readonly QueueEvent[]> {
    const contents = await readFile(this.file(id), 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    return contents.split('\n').flatMap(line => {
      const event = parseEvent(line);
      return event === undefined ? [] : [event];
    });
  }

  async append(id: SessionId, event: QueueEvent): Promise<void> {
    const file = this.file(id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(file, 'a', 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(event)}\n`, 'utf8');
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }
}

function parseEvent(line: string): QueueEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const parsed = QueueEventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
