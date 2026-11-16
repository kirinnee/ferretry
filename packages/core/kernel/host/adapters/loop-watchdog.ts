import {
  describeWatchdogFire,
  type LoopWatchdogPort,
  watchdogShouldFire,
  watchdogSilenceFrom,
} from '../loop-health.ts';

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
 * The watchdog thread's whole program, as source. INLINE, NOT A FILE, so a compiled executable carries it: a worker
 * loaded from a path would need its own entry in every release channel. The decisions it makes are the domain's own
 * functions, embedded by their source, so what the thread decides is what the unit tests prove. It ends the process with
 * SIGKILL because a loop that is not running handles no SIGTERM; the home lock is an OS lock, released with the process.
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
  /** The wall clock the heartbeat is stamped with (the thread reads the same one). */
  readonly nowMs: () => number;
  /** How often the thread looks. */
  readonly checkMs?: number;
  /** What each line it writes starts with. */
  readonly prefix: string;
}

/**
 * A watchdog on its own thread, reading a heartbeat the event loop writes into shared memory. ITS OWN THREAD IS THE
 * POINT: a timer on the loop cannot notice the loop has stopped, and a daemon that is up but not running holds its lock
 * and port while answering nothing, so no replacement can start either.
 */
export function workerLoopWatchdog(options: WorkerLoopWatchdogOptions): LoopWatchdogPort {
  const memory = new SharedArrayBuffer(LABEL_OFFSET + LABEL_BYTES);
  const beatCell = new BigInt64Array(memory, HEARTBEAT_OFFSET, 1);
  const lengthCell = new Int32Array(memory, LENGTH_OFFSET, 1);
  const labelCells = new Uint8Array(memory, LABEL_OFFSET, LABEL_BYTES);
  const encoder = new TextEncoder();
  let lastLabel = '';
  Atomics.store(beatCell, 0, BigInt(options.nowMs()));
  const source = URL.createObjectURL(new Blob([watchdogSource()], { type: 'application/javascript' }));
  const worker = new Worker(source);
  // The thread must never be the reason a finished daemon stays alive.
  (worker as Worker & { unref(): void }).unref();
  const start: WatchdogStart = {
    memory,
    limitMs: options.limitMs,
    checkMs: options.checkMs ?? 1_000,
    prefix: options.prefix,
  };
  worker.postMessage(start);
  return {
    beat(during) {
      Atomics.store(beatCell, 0, BigInt(options.nowMs()));
      const label = during.join(', ');
      if (label === lastLabel) return;
      lastLabel = label;
      Atomics.store(lengthCell, 0, encoder.encodeInto(label, labelCells).written);
    },
    stop: () => {
      void worker.terminate();
    },
  };
}
