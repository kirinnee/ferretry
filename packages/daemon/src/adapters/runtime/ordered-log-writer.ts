import { write, writeSync } from 'node:fs';
import { promisify } from 'node:util';

/** The two writes the log makes, injected so a test can hold a write in flight, cut one short, or fail one. */
export interface LogDescriptorWrites {
  /** Returns how many of `bytes`, from `offset`, the kernel took. */
  writeSync(descriptor: number, bytes: Uint8Array, offset: number): number;
  /** Resolves how many of `bytes`, from `offset`, the kernel took. */
  write(descriptor: number, bytes: Uint8Array, offset: number): Promise<number>;
}

const writeAsync = promisify(write);

const nodeLogDescriptorWrites: LogDescriptorWrites = {
  writeSync: (descriptor, bytes, offset) => writeSync(descriptor, bytes, offset, bytes.byteLength - offset),
  write: async (descriptor, bytes, offset) =>
    (await writeAsync(descriptor, bytes, offset, bytes.byteLength - offset)).bytesWritten,
};

/** What the log may hold unwritten while the disk is slow: a few thousand lines, never the daemon's memory. */
const MAX_QUEUED_LOG_BYTES = 4 * 1024 * 1024;

/** The bytes being written off the loop, and how many of them the kernel has confirmed. */
interface InFlight {
  readonly bytes: Uint8Array;
  confirmed: number;
}

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
 * ORDER. One write is in flight at a time, carrying every line queued before it, and a short write is resumed
 * from where the kernel stopped. A queue past {@link MAX_QUEUED_LOG_BYTES} drops lines and SAYS how many once it
 * drains, rather than growing without bound behind a disk that is not coming back.
 *
 * EXIT. {@link drain} waits — boundedly — for everything to reach the kernel; a daemon that is stopping calls
 * it before it exits, and then nothing is in flight. {@link flushSync} is for an exit that cannot wait: it writes,
 * synchronously, the unconfirmed rest of the write in flight and then the queue, and the log is synchronous from
 * then on. What it cannot know is whether an I/O thread is in the middle of that very write — a write cannot be
 * cancelled once handed over — so if that thread finishes before the process is gone, the in-flight bytes land
 * TWICE, the second copy after the lines written behind them — possibly only a partial prefix of it. NOTHING IS
 * LOST; a repeated tail is possible whenever the process exits with a write in flight: an abrupt exit, or an
 * ordinary stop whose bounded {@link drain} ran out first. That is the trade chosen for a crash log: losing its
 * last line is worse.
 *
 * A FAILED WRITE IS SWALLOWED, as it always was: losing the log is bad, a daemon stopped by its own log is worse.
 */
export class OrderedLogWriter {
  #async = false;
  #queue: string[] = [];
  #queuedBytes = 0;
  #dropped = 0;
  #inFlight: InFlight | undefined;
  /** The running pump, if any. Set and cleared SYNCHRONOUSLY with the queue check, so no line is ever left behind. */
  #pump: Promise<void> | undefined;

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
      this.#writeNow(new TextEncoder().encode(text));
      return;
    }
    if (this.#queuedBytes + text.length > this.maxQueuedBytes) {
      this.#dropped += 1;
      return;
    }
    this.#queue.push(text);
    this.#queuedBytes += text.length;
    this.#pump ??= this.#run();
  }

  /** Resolves once everything written so far has reached the kernel, or after `withinMs`, whichever is first. */
  async drain(withinMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>(resolve => {
      timer = setTimeout(() => resolve('late'), withinMs);
    });
    try {
      for (let pump = this.#pump; pump !== undefined; pump = this.#pump)
        if ((await Promise.race([pump.then(() => 'done' as const), late])) === 'late') return;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Everything not yet confirmed, synchronously and in order — for the moment before the process exits. From
   * here on the log is synchronous, and the write that was in flight is abandoned rather than resumed.
   */
  flushSync(): void {
    this.#async = false;
    const inFlight = this.#inFlight;
    this.#inFlight = undefined;
    if (inFlight !== undefined) this.#writeNow(inFlight.bytes.subarray(inFlight.confirmed));
    const pending = this.#take();
    if (pending !== '') this.#writeNow(new TextEncoder().encode(pending));
  }

  /** How many lines are queued and not yet handed to the kernel. */
  get queuedLines(): number {
    return this.#queue.length;
  }

  /**
   * Writes until the queue is empty. The pump is cleared IN THE SAME TURN as the check that found nothing left —
   * never in a later `finally` — so a line written after that check starts a new pump instead of waiting behind
   * one that has already finished.
   */
  async #run(): Promise<void> {
    for (;;) {
      const chunk = this.#async ? this.#take() : '';
      if (chunk === '') {
        this.#pump = undefined;
        return;
      }
      const inFlight: InFlight = { bytes: new TextEncoder().encode(chunk), confirmed: 0 };
      this.#inFlight = inFlight;
      try {
        while (inFlight.confirmed < inFlight.bytes.byteLength) {
          const written = await this.writes.write(this.descriptor, inFlight.bytes, inFlight.confirmed);
          // Abandoned by an exit flush, which has already written the rest itself.
          if (this.#inFlight !== inFlight) break;
          if (written <= 0) break;
          inFlight.confirmed += written;
        }
      } catch {
        // Intentionally ignored: a log this daemon cannot write must not stop it.
      }
      if (this.#inFlight === inFlight) this.#inFlight = undefined;
      else {
        // Abandoned by an exit flush: the log is synchronous now, and nothing is left for a pump to do.
        this.#pump = undefined;
        return;
      }
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

  /** Every byte, synchronously, resuming a short write; a refusal ends the attempt quietly. */
  #writeNow(bytes: Uint8Array): void {
    try {
      for (let offset = 0; offset < bytes.byteLength; ) {
        const written = this.writes.writeSync(this.descriptor, bytes, offset);
        if (written <= 0) return;
        offset += written;
      }
    } catch {
      // Intentionally ignored: a stream this daemon cannot write to must not stop it starting.
    }
  }
}
