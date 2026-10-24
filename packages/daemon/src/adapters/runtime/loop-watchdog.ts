import {
  describeWatchdogFire,
  type LoopWatchdogPort,
  watchdogShouldFire,
  watchdogSilenceFrom,
} from '../../lib/runtime/liveness.ts';
import { LoadSafeWorker } from './load-safe-worker.ts';

/** How many bytes of "what was running" the watchdog can quote. Longer lists are cut, never refused. */
const LABEL_BYTES = 2_048;
/** The heartbeat (one 64-bit integer), the label's length (one 32-bit integer), then the label. */
const HEARTBEAT_OFFSET = 0;
const LENGTH_OFFSET = 8;
const LABEL_OFFSET = 12;

/** What the watchdog thread is told once, at start. */
interface WatchdogStart {
  readonly memory: SharedArrayBuffer;
  readonly limitMs: number;
  readonly checkMs: number;
  readonly prefix: string;
}

/**
 * The watchdog thread's whole program, as source.
 *
 * INLINE, NOT A FILE, so a compiled executable carries it: a worker loaded from a path would need its own
 * entry point in every release channel, and a channel that forgot it would ship a watchdog that never
 * starts — the one failure nobody would see until a daemon wedged. The two decisions it makes are the
 * domain's own functions, embedded by their source, so what the thread decides is what the unit tests
 * prove.
 *
 * It ends the process with SIGKILL because nothing gentler can work: a loop that is not running handles
 * no SIGTERM, runs no cleanup and answers nothing. The state home's lock is an operating-system lock and
 * is released with the process, so the service manager's replacement can take it at once.
 */
function watchdogSource(): string {
  return `
const shouldFire = (${watchdogShouldFire.toString()});
const describe = (${describeWatchdogFire.toString()});
const silenceFrom = (${watchdogSilenceFrom.toString()});
self.onmessage = ({ data }) => {
  const beat = new BigInt64Array(data.memory, ${String(HEARTBEAT_OFFSET)}, 1);
  const length = new Int32Array(data.memory, ${String(LENGTH_OFFSET)}, 1);
  const label = new Uint8Array(data.memory, ${String(LABEL_OFFSET)}, ${String(LABEL_BYTES)});
  const decoder = new TextDecoder();
  let previousCheck = Date.now();
  let from = 0;
  setInterval(() => {
    const now = Date.now();
    from = silenceFrom(Number(Atomics.load(beat, 0)), now, previousCheck, from, data.checkMs);
    previousCheck = now;
    const silent = now - from;
    if (!shouldFire(silent, data.limitMs)) return;
    const during = decoder.decode(label.slice(0, Atomics.load(length, 0)));
    console.error(data.prefix + new Date().toISOString() + ' ! ' + describe(silent, during));
    process.kill(process.pid, 'SIGKILL');
  }, data.checkMs);
};
`;
}

export interface WorkerLoopWatchdogOptions {
  /** How long the loop may go without a heartbeat before the process is ended. */
  readonly limitMs: number;
  /** How often the thread looks. */
  readonly checkMs?: number;
  /** What each line it writes starts with — the daemon's name, as its journal introduces it. */
  readonly prefix: string;
}

/**
 * A watchdog on its own thread, reading a heartbeat the event loop writes into shared memory.
 *
 * ITS OWN THREAD IS THE POINT. A timer on the event loop cannot notice that the event loop has stopped,
 * and a daemon that is up but not running — the state a real Mac sat in for minutes at a time — holds
 * its lock and its port while answering nothing, so no replacement can start either. The thread shares
 * nothing with the loop but this buffer, so it keeps running exactly when the loop does not.
 */
export class WorkerLoopWatchdog implements LoopWatchdogPort {
  readonly #beat: BigInt64Array;
  readonly #length: Int32Array;
  readonly #label: Uint8Array;
  readonly #encoder = new TextEncoder();
  #lastLabel = '';
  readonly #worker: Worker;

  constructor(options: WorkerLoopWatchdogOptions) {
    const memory = new SharedArrayBuffer(LABEL_OFFSET + LABEL_BYTES);
    this.#beat = new BigInt64Array(memory, HEARTBEAT_OFFSET, 1);
    this.#length = new Int32Array(memory, LENGTH_OFFSET, 1);
    this.#label = new Uint8Array(memory, LABEL_OFFSET, LABEL_BYTES);
    Atomics.store(this.#beat, 0, BigInt(Date.now()));
    const source = URL.createObjectURL(new Blob([watchdogSource()], { type: 'application/javascript' }));
    this.#worker = new LoadSafeWorker(source);
    // The thread must never be the reason a finished daemon stays alive.
    this.#worker.unref();
    const start: WatchdogStart = {
      memory,
      limitMs: options.limitMs,
      checkMs: options.checkMs ?? 1_000,
      prefix: options.prefix,
    };
    this.#worker.postMessage(start);
  }

  beat(during: readonly string[]): void {
    Atomics.store(this.#beat, 0, BigInt(Date.now()));
    const label = during.join(', ');
    if (label === this.#lastLabel) return;
    this.#lastLabel = label;
    const written = this.#encoder.encodeInto(label, this.#label).written;
    Atomics.store(this.#length, 0, written);
  }

  stop(): void {
    this.#worker.terminate();
  }
}
