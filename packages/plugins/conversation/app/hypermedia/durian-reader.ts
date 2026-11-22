import type { ReadMessage } from './parse-message.ts';
import { DOCUMENT_BYTES_PER_BYTE, exceedsMessageCap, exceedsPreParseLimits } from './limits.ts';
import { type ReadRequest, isWorkerMessage, type WorkerMessage } from './durian-wire.ts';

/**
 * THE PAGE'S SIDE OF READING A MESSAGE: it asks the Durian worker (`durian-worker.ts`) and keeps what comes back (r12 H11).
 *
 * WHY. Durian's parser runs on the thread that draws the page, and a parse of text that looks ordinary can take seconds; no
 * timer or try/catch on that thread can stop a loop that is running, and an agent's message (quoted web text included) is read
 * again every time a chat opens. So the parse runs in a worker, and THIS file's one hard rule is the budget: a parse that has
 * not answered in {@link PARSE_BUDGET_MS} is ended with `terminate()`, the only thing that can end it, and that message is
 * shown as the plain text it is, with a note that says so.
 *
 * WHAT IT KEEPS.
 *  - ONE WORKER, ONE PARSE AT A TIME. The budget is the time a parse takes, not the time it waited, and a killed parse never
 *    takes a neighbour with it: the next ask starts a new worker. The worker says `ready` first, so loading its code is not
 *    counted against the first message.
 *  - A BOUNDED CACHE OF OUTCOMES, by the message's own text (never a hash: a collision would draw one message as another),
 *    for a reader that has finished AND for one that was killed, so a message that was too slow is not parsed again every time
 *    the chat opens or scrolls. It is bounded by weight, so a few huge messages cannot hold the page's memory.
 *  - ONE ASK PER MESSAGE ON SCREEN, THE LATEST. A message that is still streaming changes many times a second; each change
 *    replaces the one waiting for it (nothing queues behind itself), and a streaming message is asked for at most once per
 *    {@link STREAM_INTERVAL_MS}. While the next answer is awaited the last one stays drawn, so a growing message does not
 *    blink to plain text and back.
 *
 * A message that is over the author's cap ({@link exceedsMessageCap}) or over a pre-parse limit ({@link exceedsPreParseLimits}) never reaches the worker, and where there is no worker
 * at all (the build did not make one, or the browser refused it) a message is shown as text, never as nothing.
 */

/**
 * How long a parse may run, from the moment the worker is asked, before the worker is terminated. The page's main thread is free
 * the whole time (the parse is in the worker), so the budget is not a frame budget: it is how long a reader may be left on the
 * plain text of one message. 150 ms turned honest messages of ~140 KB into plain text on a laptop and would turn far smaller
 * ones on a phone; 500 ms leaves those alone and still ends a parse that does not return in about half a second.
 */
export const PARSE_BUDGET_MS = 500;
/** How long a worker may take to say it is loaded before it is given up on (a cold start on a phone over a slow link is seconds). */
export const STARTUP_BUDGET_MS = 8_000;
/** The least time between two asks for the same streaming message. */
export const STREAM_INTERVAL_MS = 100;
/** The most the cache may hold, in characters: a source counts once, a read document up to {@link DOCUMENT_WEIGHT} times more. */
export const CACHE_WEIGHT = 16_000_000;
/** What a read document weighs against its source: the most `limits.ts` lets it be (most are far less). */
const DOCUMENT_WEIGHT = DOCUMENT_BYTES_PER_BYTE;

/** Why a message is plain text: too slow, the parse failed, no worker is available, or it is over a cap. */
/** `capped`: over the author's cap (shown as text, no note, as before). `limit`: over a pre-parse limit, never asked of the worker (r12 H11a). The rest are the worker's answer or its absence. */
type PlainReason = 'slow' | 'failed' | 'unavailable' | 'text' | 'limit' | 'capped';

/** What a message is, now: being read, read, or plain text (with the note that says so). */
export type Reading =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'rich';
      readonly read: ReadMessage;
      /** The id prefix this document was read with: the same for every message of the same text, so the document can be kept. */
      readonly prefix: string;
    }
  | { readonly kind: 'plain'; readonly reason: PlainReason };

const PENDING: Reading = { kind: 'pending' };
const plain = (reason: PlainReason): Reading => ({ kind: 'plain', reason });
const OVER_CAP: Reading = plain('capped');
const OVER_LIMIT: Reading = plain('limit');

/** The slice of a `Worker` the reader uses. */
export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

/** The clock and timers the reader uses, so a test can run them. */
export interface Timers {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
  readonly now: () => number;
}

const SYSTEM_TIMERS: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

export interface ReaderDeps {
  /** Starts a worker. A rejection (the build has none, the browser refused it) means no worker is available. */
  readonly spawn: () => Promise<WorkerLike>;
  readonly timers?: Timers;
  readonly parseBudgetMs?: number;
  readonly startupBudgetMs?: number;
  readonly streamIntervalMs?: number;
  readonly cacheWeight?: number;
}

/** A least-recently-used map bounded by weight, not by count. */
class WeightedLru {
  private readonly entries = new Map<string, { readonly reading: Reading; readonly weight: number }>();
  private total = 0;
  constructor(private readonly capacity: number) {}

  get(source: string): Reading | undefined {
    const entry = this.entries.get(source);
    if (entry === undefined) return undefined;
    this.entries.delete(source);
    this.entries.set(source, entry);
    return entry.reading;
  }

  set(source: string, reading: Reading): void {
    this.entries.delete(source);
    const weight = 1 + source.length * (reading.kind === 'rich' ? 1 + DOCUMENT_WEIGHT : 1);
    this.entries.set(source, { reading, weight });
    this.total = [...this.entries.values()].reduce((sum, entry) => sum + entry.weight, 0);
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.capacity || this.entries.size === 1) break;
      this.entries.delete(oldest);
      this.total -= entry.weight;
    }
  }
}

/** One message on screen: what it last asked for, and the last document it drew. */
export interface Slot {
  /** The ask waiting to be sent: replaced by every newer one. */
  job: { readonly source: string; readonly arriving: boolean } | undefined;
  /** The last document this message drew, kept while its next one is awaited. */
  drawn: Reading | undefined;
  /** When this slot's last ask was sent. */
  lastSent: number;
  /** A pending delayed ask (a streaming message asked for again too soon). */
  timer: unknown;
}

interface Running {
  readonly id: number;
  readonly slot: Slot;
  readonly source: string;
  readonly arriving: boolean;
  readonly timer: unknown;
}

/** The id prefix of a message: made of its text, so it is the same every time the message is read (and so cached). */
export function idPrefixOf(source: string): string {
  // cyrb53: a decoration of an id, never a key, so a collision costs nothing but two messages sharing an anchor.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `dh-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}-`;
}

export interface DurianReader {
  /** A fresh slot for one message on screen. */
  slot(): Slot;
  /** What the message is now: from the cache, else the document it last drew, else pending. Stable until something changes. */
  snapshot(slot: Slot, source: string, arriving: boolean): Reading;
  /** Asks for the message to be read (the latest ask of a slot replaces its earlier one). */
  want(slot: Slot, source: string, arriving: boolean): void;
  /** The message is gone from the screen: its waiting ask is dropped. */
  release(slot: Slot): void;
  subscribe(listener: () => void): () => void;
}

/** The reader over one worker at a time. See the file's header. */
export function createDurianReader(deps: ReaderDeps): DurianReader {
  const timers = deps.timers ?? SYSTEM_TIMERS;
  const parseBudget = deps.parseBudgetMs ?? PARSE_BUDGET_MS;
  const startupBudget = deps.startupBudgetMs ?? STARTUP_BUDGET_MS;
  const streamInterval = deps.streamIntervalMs ?? STREAM_INTERVAL_MS;
  const capacity = deps.cacheWeight ?? CACHE_WEIGHT;
  const settled = [new WeightedLru(capacity / 2), new WeightedLru(capacity / 2)] as const;
  const listeners = new Set<() => void>();
  const waiting: Slot[] = [];
  let worker: WorkerLike | undefined;
  let ready = false;
  let starting = false;
  let startupTimer: unknown;
  let running: Running | undefined;
  let nextId = 1;

  const cached = (source: string, arriving: boolean): Reading | undefined => {
    if (exceedsMessageCap(source)) return OVER_CAP;
    const known = settled[arriving ? 1 : 0].get(source);
    if (known !== undefined) return known;
    // THE PRE-PARSE LIMITS (r12 H11a) COME BEFORE THE WORKER IS ASKED: one linear pass over the text on this thread, and a message
    // over a limit is plain text without a worker ever being started for it. The outcome is kept, so the pass runs once per text.
    if (!exceedsPreParseLimits(source)) return undefined;
    settled[arriving ? 1 : 0].set(source, OVER_LIMIT);
    return OVER_LIMIT;
  };
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const keep = (slot: Slot, source: string, arriving: boolean, reading: Reading): void => {
    settled[arriving ? 1 : 0].set(source, reading);
    if (reading.kind === 'rich') slot.drawn = reading;
  };

  /** Ends the worker, whatever it was doing. */
  const dropWorker = (): void => {
    const gone = worker;
    worker = undefined;
    ready = false;
    starting = false;
    if (startupTimer !== undefined) timers.clear(startupTimer);
    startupTimer = undefined;
    if (gone !== undefined) {
      gone.onmessage = null;
      gone.onerror = null;
      gone.onmessageerror = null;
      gone.terminate();
    }
  };

  /** The running parse is over with this outcome. */
  const finish = (reading: Reading): void => {
    const done = running;
    running = undefined;
    if (done === undefined) return;
    timers.clear(done.timer);
    keep(done.slot, done.source, done.arriving, reading);
    notify();
  };

  /** No worker can be had: everything waiting is plain text, and the next ask tries again. */
  const unavailable = (): void => {
    dropWorker();
    for (const slot of waiting.splice(0)) {
      const job = slot.job;
      slot.job = undefined;
      if (job !== undefined) settled[job.arriving ? 1 : 0].set(job.source, plain('unavailable'));
    }
    notify();
  };

  const onMessage = (message: WorkerMessage): void => {
    if (message.kind === 'ready') {
      if (startupTimer !== undefined) timers.clear(startupTimer);
      startupTimer = undefined;
      ready = true;
      starting = false;
      pump();
      return;
    }
    const current = running;
    if (current === undefined || current.id !== message.id) return;
    if (message.kind === 'read')
      finish({
        kind: 'rich',
        read: { doc: message.doc, drawable: new Map(message.drawable) },
        prefix: idPrefixOf(current.source),
      });
    else finish(plain(message.kind === 'text' ? 'text' : 'failed'));
    pump();
  };

  const start = (): void => {
    starting = true;
    startupTimer = timers.set(unavailable, startupBudget);
    deps.spawn().then(
      spawned => {
        if (!starting || worker !== undefined) {
          spawned.terminate();
          return;
        }
        worker = spawned;
        spawned.onmessage = event => {
          if (isWorkerMessage(event.data)) onMessage(event.data);
        };
        const crashed = (): void => {
          if (running === undefined) unavailable();
          else {
            dropWorker();
            finish(plain('failed'));
            pump();
          }
        };
        spawned.onerror = crashed;
        spawned.onmessageerror = crashed;
      },
      () => {
        if (starting) unavailable();
      },
    );
  };

  /** Sends the next waiting ask, starting the worker first if there is none. */
  function pump(): void {
    if (running !== undefined || starting) return;
    let next: Slot | undefined;
    for (next = waiting.shift(); next !== undefined; next = waiting.shift()) {
      const job = next.job;
      if (job !== undefined && cached(job.source, job.arriving) === undefined) break;
      next.job = undefined;
    }
    if (next === undefined || next.job === undefined) return;
    if (worker === undefined || !ready) {
      waiting.unshift(next);
      if (!starting) start();
      return;
    }
    const { source, arriving } = next.job;
    next.job = undefined;
    next.lastSent = timers.now();
    const id = nextId++;
    const request: ReadRequest = { kind: 'read', id, source, idPrefix: idPrefixOf(source), arriving };
    const slot = next;
    const sentTo = worker;
    running = {
      id,
      slot,
      source,
      arriving,
      timer: timers.set(() => {
        // The only thing that can stop a parse that is still running.
        if (running?.id !== id) return;
        dropWorker();
        finish(plain('slow'));
        pump();
      }, parseBudget),
    };
    sentTo.postMessage(request);
  }

  const enqueue = (slot: Slot): void => {
    if (!waiting.includes(slot)) waiting.push(slot);
    pump();
  };

  return {
    slot: () => ({ job: undefined, drawn: undefined, lastSent: Number.NEGATIVE_INFINITY, timer: undefined }),
    snapshot: (slot, source, arriving) => cached(source, arriving) ?? slot.drawn ?? PENDING,
    want(slot, source, arriving) {
      if (cached(source, arriving) !== undefined) {
        slot.job = undefined;
        return;
      }
      slot.job = { source, arriving };
      if (slot.timer !== undefined) return;
      const wait = slot.lastSent + streamInterval - timers.now();
      if (!arriving || wait <= 0) {
        enqueue(slot);
        return;
      }
      slot.timer = timers.set(() => {
        slot.timer = undefined;
        if (slot.job !== undefined) enqueue(slot);
      }, wait);
    },
    release(slot) {
      slot.job = undefined;
      if (slot.timer !== undefined) timers.clear(slot.timer);
      slot.timer = undefined;
      const at = waiting.indexOf(slot);
      if (at >= 0) waiting.splice(at, 1);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
