import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type QueueEvent, QueueEventSchema } from '../../../lib/session/queue/index.ts';
import type { SessionQueueStore } from '../../../lib/session/queue/ports.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/**
 * What one read already parsed of a log: the file it was (`dev`/`ino`), how many bytes of whole lines it
 * consumed, and the events those lines held. A read that finds the same file grown parses only the bytes
 * past `consumed`.
 */
interface ParsedPrefix {
  readonly dev: number;
  readonly ino: number;
  readonly consumed: number;
  readonly events: readonly QueueEvent[];
}

/** The most logs whose parse is kept between reads; the least recently read is let go first. */
export const QUEUE_READ_CACHE_ENTRIES = 256;

const NEWLINE = 0x0a;

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
 *
 * PARSED ONCE (&F4319). The deliverer reads a queue three or more times per look and looks every few
 * seconds, and a long-lived session's log only grows: a 29 MB, 228,788-line log cost ~300 ms of parsing on
 * the event loop per read, which starved every request until the app's reads timed out. So the whole lines
 * already parsed are kept — keyed on the file's identity and the bytes they came from — and a read parses
 * only what was appended since. A file that is replaced, shrank, or no longer ends a line where the kept
 * prefix ended is read again from the start. The torn tail (bytes after the last newline) is never kept: it
 * is parsed on each read as before, so a final line still being written is read once it is whole.
 */
export class FileSessionQueueStore implements SessionQueueStore {
  /** Insertion order is recency: a read moves its entry to the end, and the oldest is evicted past the cap. */
  private readonly parsed = new Map<string, ParsedPrefix>();

  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly cacheEntries: number = QUEUE_READ_CACHE_ENTRIES,
  ) {}

  file(id: SessionId): string {
    return join(this.sessionDirectory(id), 'channel', 'queue.jsonl');
  }

  async read(id: SessionId): Promise<readonly QueueEvent[]> {
    const file = this.file(id);
    const handle = await open(file, 'r').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (handle === undefined) {
      this.parsed.delete(file);
      return [];
    }
    try {
      const facts = await handle.stat();
      const kept = this.parsed.get(file);
      const prefix =
        kept !== undefined &&
        kept.dev === facts.dev &&
        kept.ino === facts.ino &&
        facts.size >= kept.consumed &&
        (await endsLineAt(handle, kept.consumed))
          ? kept
          : { dev: facts.dev, ino: facts.ino, consumed: 0, events: [] };
      const appended = await readFrom(handle, prefix.consumed, facts.size);
      const lastNewline = appended.lastIndexOf(NEWLINE);
      const whole = lastNewline < 0 ? 0 : lastNewline + 1;
      const fresh = parseLines(appended.subarray(0, whole).toString('utf8'));
      const tail = parseLines(appended.subarray(whole).toString('utf8'));
      const events = fresh.length === 0 ? prefix.events : [...prefix.events, ...fresh];
      this.keep(file, { dev: prefix.dev, ino: prefix.ino, consumed: prefix.consumed + whole, events });
      return tail.length === 0 ? events : [...events, ...tail];
    } finally {
      await handle.close();
    }
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

  private keep(file: string, prefix: ParsedPrefix): void {
    this.parsed.delete(file);
    this.parsed.set(file, prefix);
    for (const oldest of this.parsed.keys()) {
      if (this.parsed.size <= this.cacheEntries) break;
      this.parsed.delete(oldest);
    }
  }
}

/** Whether the byte just before `offset` is a newline — the kept prefix still ends a line there. */
async function endsLineAt(handle: FileHandle, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const byte = Buffer.alloc(1);
  const { bytesRead } = await handle.read(byte, 0, 1, offset - 1);
  return bytesRead === 1 && byte[0] === NEWLINE;
}

/**
 * The bytes from `start` up to `end` (the size the file had when stat'd). A short read is safe: only the whole
 * lines in what came back are kept, so whatever was not read is read next time, as is anything appended since.
 */
async function readFrom(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(end - start);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  return buffer.subarray(0, bytesRead);
}

function parseLines(contents: string): QueueEvent[] {
  if (contents === '') return [];
  return contents.split('\n').flatMap(line => {
    const event = parseEvent(line);
    return event === undefined ? [] : [event];
  });
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
