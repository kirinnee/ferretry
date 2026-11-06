import { write, writeSync } from 'node:fs';
import { promisify } from 'node:util';

/** The two writes the log makes, injected so a test can hold a write in flight or make one fail. */
export interface LogDescriptorWrites {
  writeSync(descriptor: number, text: string): number;
  /** Resolves how many of `bytes`, from `offset`, the kernel took. */
  write(descriptor: number, bytes: Uint8Array, offset: number): Promise<number>;
}

const writeAsync = promisify(write);

const nodeLogDescriptorWrites: LogDescriptorWrites = {
  writeSync: (descriptor, text) => writeSync(descriptor, text),
  write: async (descriptor, bytes, offset) =>
    (await writeAsync(descriptor, bytes, offset, bytes.byteLength - offset)).bytesWritten,
};

/** What the log may hold unwritten while the disk is slow: a few thousand lines, never the daemon's memory. */
const MAX_QUEUED_LOG_BYTES = 4 * 1024 * 1024;

/**
 * The daemon's log lines onto one descriptor, IN ORDER — synchronously while it boots, off the loop after.
 *
 * WHILE IT BOOTS, A LINE IS IN THE KERNEL BEFORE `write` RETURNS. A boot that wedges must leave its last step
 * in the file the operator is told to read; a line still waiting in this process would reproduce the empty log
 * that motivated writing one at all.
 *
 * ONCE IT SERVES ({@link goAsync}), A LINE IS QUEUED AND WRITTEN ON THE I/O THREADS. A `write` to a file can
 * block — the kernel throttles a writer while dirty pages pile up, and charges the page it allocates to this
 * daemon's memory budget — and on 2026-11-05 the log's own `writeSync` held the event loop for 9.9 s across
 * seven stalls, each while the disk was saturated. A wedged loop writes nothing either way, so after boot the
 * synchronous write bought nothing but the stalls.
 *
 * Lines leave in the order they were written: one write is in flight at a time, carrying every line queued
 * before it. A queue past {@link MAX_QUEUED_LOG_BYTES} drops lines and SAYS how many once it drains, rather
 * than growing without bound behind a disk that is not coming back. {@link flushSync} writes whatever is still
 * queued before the process exits, so an exit's last words are not lost to the switch.
 *
 * A FAILED WRITE IS SWALLOWED, as it always was: losing the log is bad, a daemon stopped by its own log is worse.
 */
export class OrderedLogWriter {
  #async = false;
  #queue: string[] = [];
  #queuedBytes = 0;
  #dropped = 0;
  #pumping = false;

  constructor(
    private readonly descriptor: number,
    private readonly writes: LogDescriptorWrites = nodeLogDescriptorWrites,
    private readonly maxQueuedBytes: number = MAX_QUEUED_LOG_BYTES,
  ) {}

  /** Lines written from now on are queued and written off the loop. */
  goAsync(): void {
    this.#async = true;
  }

  write(text: string): void {
    if (!this.#async) {
      this.#writeNow(text);
      return;
    }
    if (this.#queuedBytes + text.length > this.maxQueuedBytes) {
      this.#dropped += 1;
      return;
    }
    this.#queue.push(text);
    this.#queuedBytes += text.length;
    if (!this.#pumping) void this.#pump();
  }

  /** Everything still queued, synchronously — for the moment before the process exits. */
  flushSync(): void {
    const pending = this.#take();
    if (pending !== '') this.#writeNow(pending);
  }

  /** How many lines are queued and not yet handed to the kernel. */
  get queuedLines(): number {
    return this.#queue.length;
  }

  async #pump(): Promise<void> {
    this.#pumping = true;
    try {
      for (let chunk = this.#take(); chunk !== ''; chunk = this.#take()) {
        const bytes = new TextEncoder().encode(chunk);
        try {
          for (let offset = 0; offset < bytes.byteLength; ) {
            const written = await this.writes.write(this.descriptor, bytes, offset);
            if (written <= 0) break;
            offset += written;
          }
        } catch {
          // Intentionally ignored: a log this daemon cannot write must not stop it.
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  #take(): string {
    let text = this.#queue.join('');
    this.#queue = [];
    this.#queuedBytes = 0;
    if (this.#dropped > 0) {
      text += `${String(this.#dropped)} log line(s) were dropped while the disk was too slow to take them\n`;
      this.#dropped = 0;
    }
    return text;
  }

  #writeNow(text: string): void {
    try {
      this.writes.writeSync(this.descriptor, text);
    } catch {
      // Intentionally ignored: a stream this daemon cannot write to must not stop it starting.
    }
  }
}
