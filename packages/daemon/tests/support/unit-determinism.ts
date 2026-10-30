import { afterEach, beforeEach } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { FORBIDDEN_TEST_HOST } from './offline-environment.ts';

/**
 * THE UNIT TIER IS DETERMINISTIC BY CONSTRUCTION. Preloaded by `bunfig.unit.toml` only, after
 * `offline-environment.ts`.
 *
 * Every unit-tier flake CI saw in the week to 2026-10-29 was the real world leaking into a unit test: a
 * real timer racing a render, a wall-clock wait that ran out on a loaded runner, a `fetch` to a host
 * that was not there. None of those tests needed the real world, so this tier does not have one:
 *
 * - TIME IS VIRTUAL. `Date.now()`, `new Date()`, `performance.now()`, `process.hrtime` and
 *   `Bun.nanoseconds()` read ONE clock, which starts every test at {@link UNIT_CLOCK_ORIGIN}. Every
 *   timer with a delay — `setTimeout`, `setInterval`, `Bun.sleep`, `AbortSignal.timeout`,
 *   `node:timers(/promises)`, animation frames — waits on that clock, and the clock moves on idle, in
 *   order ("HOW TIME MOVES" below), or when a test moves it (`unitClock` in `unit-clock.ts`). No real
 *   millisecond ever reaches a unit test, so nothing it decides can depend on how fast the machine is.
 * - THE ZONE IS UTC. `TZ` is pinned, so a date renders the same on a laptop and on a runner.
 * - THE OUTSIDE WORLD IS REFUSED. A real `fetch` (beyond `data:`/`blob:`), `WebSocket`, `node:net` /
 *   `tls` / `http(s)` / `http2` / `dgram`, `Bun.serve` / `listen` / `connect` / `udpSocket` (rule
 *   `socket`), and `node:child_process`, `Bun.spawn` / `spawnSync`, `Worker` (rule `process`) throw
 *   {@link UnitDeterminismError}, as do a synchronous `Bun.gc(true)` (rule `gc`) and `Bun.sleepSync`
 *   (rule `timer`), naming the rule, where it was asked for, and what to use instead. A test that
 *   genuinely needs one of them is an integration test.
 *
 * A refusal needs one of OUR frames on the stack (`packages/`, `tests/`, `scripts/`, never
 * `node_modules`), so a library's own bookkeeping is its business; {@link UNIT_DETERMINISM_ALLOWLIST}
 * lets a library frame through for one rule only when its entry says why that cannot decide an outcome.
 *
 * `FY_UNIT_GUARD=report` records refusals instead of throwing (one JSON line per distinct site, to
 * `FY_UNIT_GUARD_REPORT`) — the measuring mode used to find violators. CI never sets it.
 */

export type UnitDeterminismRule = 'socket' | 'process' | 'timer' | 'gc';

/** What a test should use instead, per rule — the sentence a refusal ends with. */
const UNIT_DETERMINISM_REMEDY: Record<UnitDeterminismRule, string> = {
  socket:
    'hand the code a fake transport (a stubbed `fetch`, an in-memory carrier or socket pair); a test that needs a real socket is an integration test',
  process:
    'inject the spawn port (a `*Spawn` / `*Spawner` / `*Runner` dependency) with a scripted child; a test that needs a real program or thread is an integration test',
  gc: 'measure memory in a child process the test can kill (an integration or realworld test): a synchronous full collection in the shared runner wedged it for good after earlier files had ended real Workers (#903)',
  timer:
    'move the virtual clock with `unitClock.advance(ms)` (packages/daemon/tests/support/unit-clock.ts); a synchronous sleep cannot wait on it',
};

export class UnitDeterminismError extends Error {
  constructor(
    readonly rule: UnitDeterminismRule,
    readonly detail: string,
    readonly where: string,
  ) {
    super(
      `unit tests are deterministic: refused ${detail} [rule: ${rule}] at ${where}. Instead, ${UNIT_DETERMINISM_REMEDY[rule]}. (packages/daemon/tests/support/unit-determinism.ts)`,
    );
    this.name = 'UnitDeterminismError';
  }
}

/**
 * Library frames that may ask for one refused thing on our behalf, each with the reason it cannot
 * decide an outcome. Matched against the FIRST frame on the stack — the code that called the refused
 * API — and only for the rule it names.
 */
const UNIT_DETERMINISM_ALLOWLIST: ReadonlyArray<{
  readonly rule: UnitDeterminismRule;
  readonly frame: RegExp;
  readonly why: string;
}> = [];

/**
 * The instant every unit test starts at: 2026-10-30T12:00:00.000Z. Fixed, so a test that renders
 * "today" or "3 days ago" renders the same thing on every day it runs; near the date the suite was
 * written against, so fixtures stamped with real recent dates stay in the recent past.
 */
export const UNIT_CLOCK_ORIGIN = Date.UTC(2026, 9, 30, 12, 0, 0, 0);

/** Where `performance.now()` reads at the origin: a page that has been open for a second. */
const PERFORMANCE_ORIGIN = 1_000;

process.env.TZ = 'UTC';

const mode = process.env.FY_UNIT_GUARD ?? 'enforce';
const require = createRequire(import.meta.url);

// ─── where a call came from ──────────────────────────────────────────────────────────────────────

interface Frame {
  readonly file: string;
  readonly line: string;
}

const FRAME = /\(?((?:\/|file:\/\/)[^():]+):(\d+):\d+\)?\s*$/u;

const framesOf = (stack: string): Frame[] =>
  stack
    .split('\n')
    .slice(1)
    .map(line => FRAME.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ file: (match[1] ?? '').replace(/^file:\/\//u, ''), line: match[2] ?? '' }))
    .filter(frame => frame.file !== import.meta.path);

const isLibrary = (frame: Frame) => frame.file.includes('/node_modules/');
const isOurs = (frame: Frame) => !isLibrary(frame) && /\/(packages|tests|scripts)\//u.test(frame.file);

const ROOT = import.meta.path.replace(/packages\/daemon\/tests\/support\/unit-determinism\.ts$/u, '');
const relative = (frame: Frame) =>
  `${frame.file.startsWith(ROOT) ? frame.file.slice(ROOT.length) : frame.file}:${frame.line}`;

const sightings = new Set<string>();

/** Throws (or, in report mode, records) when `rule` is asked for from our code. */
const check = (rule: UnitDeterminismRule, detail: string): void => {
  if (mode === 'off') return;
  const frames = framesOf(new Error().stack ?? '');
  const first = frames[0];
  if (
    first !== undefined &&
    UNIT_DETERMINISM_ALLOWLIST.some(entry => entry.rule === rule && entry.frame.test(first.file))
  )
    return;
  const ours = frames.find(isOurs);
  if (ours === undefined) return;
  const where = relative(ours);
  if (mode === 'report') {
    const test = frames.find(frame => frame.file.includes('/tests/unit/'));
    const via = first !== undefined && isLibrary(first) ? first.file.replace(/^.*\/node_modules\//u, '') : '';
    const key = `${rule}|${detail}|${where}|${via}`;
    if (sightings.has(key)) return;
    sightings.add(key);
    // Written as it is seen: a runner that ends the process by force never reaches an exit hook.
    const path = process.env.FY_UNIT_GUARD_REPORT;
    if (path)
      appendFileSync(path, `${JSON.stringify({ rule, detail, test: test ? relative(test) : '', ours: where, via })}\n`);
    return;
  }
  throw new UnitDeterminismError(rule, detail, where);
};

type AnyFunction = (...args: never[]) => unknown;

const define = (owner: object, name: string, value: unknown) => {
  try {
    Object.defineProperty(owner, name, { value, writable: true, configurable: true, enumerable: true });
  } catch {
    (owner as Record<string, unknown>)[name] = value;
  }
};

/** Replaces `owner[name]` with a version that checks first, keeping every static the original had. */
const refuse = (
  owner: object,
  name: string,
  rule: UnitDeterminismRule,
  detail: string,
  when?: (args: unknown[]) => boolean,
) => {
  const original = (owner as Record<string, unknown>)[name];
  if (typeof original !== 'function') return;
  const guarded = function (this: unknown, ...args: unknown[]) {
    if (when === undefined || when(args)) check(rule, detail);
    return Reflect.apply(original as AnyFunction, this, args as never[]);
  };
  Object.defineProperties(guarded, Object.getOwnPropertyDescriptors(original));
  define(owner, name, guarded);
};

const refuseConstruction = (owner: object, name: string, rule: UnitDeterminismRule, detail: string) => {
  const Original = (owner as Record<string, unknown>)[name];
  if (typeof Original !== 'function') return;
  define(
    owner,
    name,
    new Proxy(Original, {
      construct(target, args, newTarget) {
        check(rule, detail);
        return Reflect.construct(target, args, newTarget);
      },
    }),
  );
};

// ─── the virtual clock ───────────────────────────────────────────────────────────────────────────
//
// HOW TIME MOVES. A test that never mentions the clock still sees its debounces, polls and deadlines
// fire, in order, because the clock ADVANCES ON IDLE: whenever virtual timers are waiting and the
// process has no other work in hand — no zero-delay task, no `setImmediate` (React's scheduler runs on
// it), no WebCrypto or file-system promise outstanding — for {@link IDLE_PROBES} consecutive turns, the
// clock jumps to the earliest timer and runs it (and every timer due at that same instant, in the order
// they were set). A wait that polls a condition (`unitClock.turn()`, which `settleUntil` uses) takes the
// same step itself. Off-thread work therefore takes zero virtual time, and a deadline can never beat the
// handshake it guards: the deadline only fires once the handshake has nothing left in flight. What
// decides the order is the code, never the machine.
//
// THE ORDER OF REAL TASKS. Immediates run first in, first out. A zero-delay timer runs after them, and
// only once no off-thread work is in flight (see drainZero) — so a test that yields a fixed number of
// zero-delay turns "for the crypto to land" gets the same answer on every machine.
//
// THREE MODES per test, reset before each one:
// - `auto` (the default): advance on idle, as above.
// - `held` (`unitClock.hold()`): only `unitClock.advance(ms)` / `next()` move time, for a test that
//   asserts what is on screen BEFORE a timer fires. A held test that goes idle with timers waiting is a
//   test waiting for a clock nobody will move — it FAILS, naming where each waiting timer was set.
// - `real` (`unitClock.useRealTime(reason)`): the escape hatch, for the rare test whose subject IS real
//   time. Greppable, counted by scripts/validate/test-tiers.sh, and gone at the next test.

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetImmediate = globalThis.setImmediate;
const realClearImmediate = globalThis.clearImmediate;
const realDateNow = Date.now;
const realPerformanceNow = performance.now.bind(performance);
const realHrtime = process.hrtime;
const realNanoseconds = Bun.nanoseconds;

/** Consecutive idle turns before the clock moves: enough for a settled native callback to land. */
const IDLE_PROBES = 3;
/** Real immediates one `unitClock.turn()` lets queued work drain for before it gives the step back. */
const TURN_DRAIN_CHECKS = 50;
/**
 * Idle probes (one per event-loop iteration, a few hundred a millisecond) a HELD test may sit with
 * timers waiting, polling nothing, before it is failed as
 * deadlocked: it is parked on a promise only a timer can settle, and nothing will move the clock.
 */
const HELD_DEADLOCK_PROBES = 10_000;

type ClockMode = 'auto' | 'held' | 'real';

interface Scheduled {
  readonly id: number;
  at: number;
  readonly every: number | null;
  readonly run: () => void;
  /** Where it was set — read only when a deadlock has to be named. */
  readonly stack: string;
}

/** Elapsed virtual milliseconds since the origin; reset before every test. */
let elapsed = 0;
let nextId = 1;
let clockMode: ClockMode = 'auto';
const scheduled = new Map<number, Scheduled>();

/** Zero-delay timers queued and not yet run. */
let inFlight = 0;
/** Real immediates queued and not yet run — React's scheduler and happy-dom work on them. */
let immediates = 0;
/** Off-thread work started and not yet settled: WebCrypto and file-system promises. */
let offThread = 0;
/** The same work as promises, so a wait can await the work itself instead of counting turns past it. */
const offThreadWork = new Set<Promise<unknown>>();
/**
 * Which test the counts belong to. Work a test left behind — a crypto promise nobody awaited, an
 * immediate still queued — must not keep the NEXT test's clock from moving, so each test starts its
 * counts at zero and anything an earlier test started no longer counts when it settles.
 */
let generation = 0;
/** Zero-delay timers, in the order they were set; each runs only once no off-thread work is in flight. */
const zeroTasks = new Map<number, () => void>();
let zeroArmed = false;
let probing = false;
let idleProbes = 0;
/** Idle probes since the test last showed it is alive by polling (`unitClock.turn()`) — held mode only. */
let heldIdleProbes = 0;

/**
 * The handle a virtual timer returns. It answers what Node's `Timeout` and a browser's number both
 * answer — `ref`/`unref`/`hasRef`/`refresh`/`close`, and a numeric primitive — so code written for
 * either keeps working, and `clearTimeout` recognises it by id.
 */
class VirtualTimer {
  constructor(
    readonly id: number,
    readonly delay: number,
  ) {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  hasRef() {
    return true;
  }
  refresh() {
    const timer = scheduled.get(this.id);
    if (timer !== undefined) timer.at = elapsed + this.delay;
    return this;
  }
  close() {
    scheduled.delete(this.id);
    return this;
  }
  [Symbol.toPrimitive]() {
    return this.id;
  }
}

const delayOf = (delay: unknown): number => {
  const value = Math.floor(Number(delay ?? 0));
  return Number.isFinite(value) && value > 0 ? value : 0;
};

/** The earliest timer due by `until`, the first set among those due at the same moment. */
const nextDue = (until: number): Scheduled | undefined => {
  let earliest: Scheduled | undefined;
  for (const timer of scheduled.values())
    if (timer.at <= until && (earliest === undefined || timer.at < earliest.at)) earliest = timer;
  return earliest;
};

const advanceTo = (until: number) => {
  for (let due = nextDue(until); due !== undefined; due = nextDue(until)) {
    elapsed = due.at;
    if (due.every === null) scheduled.delete(due.id);
    else due.at += due.every;
    due.run();
  }
  elapsed = until;
};

const sitesOf = (timers: Iterable<Scheduled>): string =>
  [...timers]
    .map(timer => {
      const ours = framesOf(timer.stack).find(isOurs);
      return `  - ${timer.every === null ? 'timeout' : `interval of ${timer.every}ms`} due at +${timer.at}ms, set at ${ours ? relative(ours) : 'a library frame'}`;
    })
    .join('\n');

/** One idle check, on a REAL immediate; keeps itself going while virtual timers wait. */
const probe = () => {
  probing = false;
  if (scheduled.size === 0 || clockMode === 'real') return;
  const working = inFlight + immediates + offThread > 0;
  idleProbes = working ? 0 : idleProbes + 1;
  heldIdleProbes = working ? 0 : heldIdleProbes + 1;
  if (clockMode === 'auto' && idleProbes >= IDLE_PROBES) {
    idleProbes = 0;
    const first = nextDue(Number.POSITIVE_INFINITY);
    if (first !== undefined) advanceTo(first.at);
  } else if (clockMode === 'held' && heldIdleProbes >= HELD_DEADLOCK_PROBES) {
    const waiting = [...scheduled.values()];
    scheduled.clear();
    throw new Error(
      `unit clock deadlock: this test held the clock (unitClock.hold()) and went idle with ${waiting.length} timer(s) waiting on it:\n${sitesOf(waiting)}\nMove it with unitClock.advance(ms) or unitClock.next(), or drop hold() to let it advance on idle. (packages/daemon/tests/support/unit-determinism.ts)`,
    );
  }
  startProbing();
};

const startProbing = () => {
  if (probing || scheduled.size === 0 || clockMode === 'real') return;
  probing = true;
  Reflect.apply(realSetImmediate as AnyFunction, globalThis, [probe] as never[]);
};

const schedule = (callback: unknown, delay: number, args: unknown[], repeat: boolean): VirtualTimer => {
  if (typeof callback !== 'function') throw new TypeError('a timer callback must be a function');
  const id = nextId;
  nextId += 1;
  const wait = repeat ? Math.max(delay, 1) : delay;
  scheduled.set(id, {
    id,
    at: elapsed + wait,
    every: repeat ? wait : null,
    run: () => callback(...args),
    stack: new Error().stack ?? '',
  });
  startProbing();
  return new VirtualTimer(id, wait);
};

/** Counts a real task in hand from when it is queued until it has run or been cleared. */
const realTasks = new Map<unknown, number>();
const settleReal = (handle: unknown) => {
  const owner = realTasks.get(handle);
  if (owner === undefined) return;
  realTasks.delete(handle);
  if (owner === generation) immediates -= 1;
};
const queueReal = (queue: AnyFunction, callback: unknown, args: unknown[], extra: unknown[]) => {
  if (typeof callback !== 'function') return Reflect.apply(queue, globalThis, [callback, ...extra, ...args] as never[]);
  immediates += 1;
  let handle: unknown;
  const run = () => {
    settleReal(handle);
    callback(...args);
  };
  handle = Reflect.apply(queue, globalThis, [run, ...extra] as never[]);
  realTasks.set(handle, generation);
  return handle;
};
const clearReal = (clear: AnyFunction, handle: unknown) => {
  settleReal(handle);
  Reflect.apply(clear, globalThis, [handle] as never[]);
};

/**
 * Runs the next zero-delay timer on a real immediate — but only once no off-thread work is in flight
 * and no immediate is queued ahead of it,
 * so WebCrypto and file reads finish in zero virtual time, before anything set after them. A test that
 * yields a fixed number of zero-delay turns "for the crypto to land" therefore gets the same answer on
 * every machine, instead of whatever a millisecond per turn happened to buy.
 */
const drainZero = () => {
  zeroArmed = false;
  const next = zeroTasks.entries().next();
  if (next.done) return;
  // Behind whatever is already queued, as a timer is in a browser and in Node: React renders on
  // immediates, and a test that yields "once React has rendered" yields zero-delay turns.
  if (offThread > 0 || immediates > 0) {
    armZero();
    return;
  }
  const [id, run] = next.value;
  zeroTasks.delete(id);
  inFlight -= 1;
  if (zeroTasks.size > 0) armZero();
  run();
};
const armZero = () => {
  if (zeroArmed) return;
  zeroArmed = true;
  Reflect.apply(realSetImmediate as AnyFunction, globalThis, [drainZero] as never[]);
};

function virtualSetTimeout(callback: unknown, delay?: unknown, ...args: unknown[]) {
  if (clockMode === 'real')
    return Reflect.apply(realSetTimeout as AnyFunction, globalThis, [callback, delay, ...args] as never[]);
  const wait = delayOf(delay);
  // A zero delay is a task boundary, not a duration — see drainZero. (Bun gives a real zero `setTimeout`
  // a 1 ms floor, so its order against an immediate depended on how much real time had passed.)
  if (wait === 0) {
    if (typeof callback !== 'function') throw new TypeError('a timer callback must be a function');
    const id = nextId;
    nextId += 1;
    zeroTasks.set(id, () => callback(...args));
    inFlight += 1;
    armZero();
    return new VirtualTimer(id, 0);
  }
  return schedule(callback, wait, args, false);
}
function virtualSetInterval(callback: unknown, delay?: unknown, ...args: unknown[]) {
  if (clockMode === 'real')
    return Reflect.apply(realSetInterval as AnyFunction, globalThis, [callback, delay, ...args] as never[]);
  return schedule(callback, delayOf(delay), args, true);
}
function virtualClear(handle: unknown) {
  const id = handle instanceof VirtualTimer ? handle.id : typeof handle === 'number' ? handle : undefined;
  if (id !== undefined && zeroTasks.delete(id)) inFlight -= 1;
  else if (handle instanceof VirtualTimer) scheduled.delete(handle.id);
  else if (typeof handle === 'number' && scheduled.has(handle)) scheduled.delete(handle);
  else if (handle !== undefined && handle !== null) {
    clearReal(realClearImmediate as AnyFunction, handle);
    Reflect.apply(realClearTimeout as AnyFunction, globalThis, [handle] as never[]);
    Reflect.apply(realClearInterval as AnyFunction, globalThis, [handle] as never[]);
  }
}
function trackedSetImmediate(callback: unknown, ...args: unknown[]) {
  return queueReal(realSetImmediate as AnyFunction, callback, args, []);
}
function trackedClearImmediate(handle: unknown) {
  clearReal(realClearImmediate as AnyFunction, handle);
}

/**
 * OFF-THREAD RESULTS ARRIVE IN CALL ORDER, AT A QUIET MOMENT. Native work — WebCrypto, a file read, a
 * body read — finishes whenever the machine gets to it, so two seals started together could finish in
 * either order, and land between whichever JavaScript tasks happened to be queued then. On a loaded
 * runner that reordering was enough to move a poll, a deadline and a request count. So the wrapped call
 * returns a promise of its own, settled from {@link deliveries}: strictly in the order the calls were
 * made, one per real immediate, and only while no immediate is queued (ahead of any zero-delay timer,
 * which waits for them: off-thread work takes zero virtual time). The work counts as in
 * hand until its result is DELIVERED, so neither the clock nor a zero-delay timer moves past it.
 */
interface Delivery {
  outcome: { readonly ok: boolean; readonly value: unknown } | undefined;
  readonly settle: (ok: boolean, value: unknown) => void;
}
const deliveries: Delivery[] = [];
let deliveryArmed = false;
const deliver = () => {
  deliveryArmed = false;
  const head = deliveries[0];
  if (head?.outcome === undefined) return;
  if (immediates > 0) {
    armDelivery();
    return;
  }
  deliveries.shift();
  head.settle(head.outcome.ok, head.outcome.value);
  if (deliveries[0]?.outcome !== undefined) armDelivery();
};
const armDelivery = () => {
  if (deliveryArmed) return;
  deliveryArmed = true;
  Reflect.apply(realSetImmediate as AnyFunction, globalThis, [deliver] as never[]);
};

/** Wraps a promise-returning function so its work counts as in hand, and its result is delivered in order. */
const trackPromises = (owner: object | undefined, names: readonly string[]) => {
  if (owner === undefined) return;
  for (const name of names) {
    const original = (owner as Record<string, unknown>)[name];
    if (typeof original !== 'function') continue;
    define(owner, name, function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original as AnyFunction, this, args as never[]);
      if (!(result instanceof Promise) || clockMode === 'real') return result;
      const owner = generation;
      offThread += 1;
      let settle: Delivery['settle'] = () => {};
      const delivered = new Promise<unknown>((resolve, reject) => {
        settle = (ok, value) => {
          if (owner === generation) offThread -= 1;
          offThreadWork.delete(delivered);
          if (ok) resolve(value);
          else reject(value);
        };
      });
      const entry: Delivery = { outcome: undefined, settle };
      deliveries.push(entry);
      if (owner === generation) offThreadWork.add(delivered);
      result.then(
        value => {
          entry.outcome = { ok: true, value };
          armDelivery();
        },
        (error: unknown) => {
          entry.outcome = { ok: false, value: error };
          armDelivery();
        },
      );
      // The caller awaits the delivery; a rejection it never awaits is still its own, so it is not muted.
      return delivered;
    });
  }
};

/** The unit tier's one clock. Tests import it through `unit-clock.ts`. */
export const unitClock = {
  /** Virtual milliseconds since this test started. */
  get elapsed(): number {
    return elapsed;
  },
  /** The virtual `Date.now()`. */
  now: (): number => UNIT_CLOCK_ORIGIN + elapsed,
  /** How many timers are waiting on the clock. */
  get pending(): number {
    return scheduled.size;
  },
  /** `auto`, `held` or `real` — see the comment above. */
  get mode(): ClockMode {
    return clockMode;
  },
  /** Moves the clock by `ms`, running every timer that comes due on the way, in order. */
  advance(ms: number): void {
    if (!(ms >= 0)) throw new RangeError(`the unit clock only moves forward, not by ${ms}`);
    advanceTo(elapsed + ms);
  },
  /** Moves the clock to the next waiting timer and runs it; false when none waits. */
  next(): boolean {
    const first = nextDue(Number.POSITIVE_INFINITY);
    if (first === undefined) return false;
    advanceTo(first.at);
    return true;
  },
  /**
   * One step of a wait that polls a condition: lets the work in hand drain (up to
   * {@link TURN_DRAIN_CHECKS} real immediates), then — in `auto` mode, once nothing is in hand for
   * {@link IDLE_PROBES} checks running — moves the clock to the next waiting timer and runs it. A polling
   * wait therefore drives time itself, one timer per step, rather than hoping the background probe finds
   * a quiet moment between the React work its own `act()` flushes keep queueing. It does not count as
   * work in hand, and it tells a held clock the test is alive.
   */
  async turn(): Promise<void> {
    heldIdleProbes = 0;
    let calm = 0;
    for (let check = 0; check < TURN_DRAIN_CHECKS && calm < IDLE_PROBES; check += 1) {
      await new Promise(resolve => {
        Reflect.apply(realSetImmediate as AnyFunction, globalThis, [resolve] as never[]);
      });
      calm = inFlight + immediates + offThread > 0 ? 0 : calm + 1;
    }
    if (calm >= IDLE_PROBES && clockMode === 'auto') {
      const first = nextDue(Number.POSITIVE_INFINITY);
      if (first !== undefined) advanceTo(first.at);
    }
  },
  /** Whether off-thread work this clock tracks (WebCrypto, file promises, real tasks) is in flight. */
  get busy(): boolean {
    return inFlight + immediates + offThread > 0;
  },
  /**
   * Resolves once no off-thread work this clock tracks (WebCrypto, file promises, real zero-delay tasks)
   * has been in flight for a few consecutive turns — for a test that moves a clock of its own and must
   * let a sealed session's crypto land first. Throws, naming the count, if it never goes quiet.
   */
  async quiet(maxTurns = 10_000): Promise<void> {
    // Off-thread work is AWAITED, never counted past: how many turns a WebCrypto call takes is the
    // machine's speed, and a turn ceiling on it was a wall-clock budget by another name — it ran out on
    // a loaded runner with two seals still in flight. Only queued JavaScript tasks count toward
    // `maxTurns`, which catches a task that keeps re-queueing itself forever.
    let calm = 0;
    let turns = 0;
    while (calm < IDLE_PROBES) {
      if (offThreadWork.size > 0) {
        await Promise.allSettled([...offThreadWork]);
        calm = 0;
        continue;
      }
      if (turns >= maxTurns)
        throw new Error(
          `the unit clock never went quiet: ${inFlight + immediates} queued task(s) still re-queueing after ${maxTurns} turns`,
        );
      calm = inFlight + immediates + offThread === 0 ? calm + 1 : 0;
      turns += 1;
      await new Promise(resolve => {
        Reflect.apply(realSetImmediate as AnyFunction, globalThis, [resolve] as never[]);
      });
    }
  },
  /** Stops advancing on idle for the rest of this test: only advance()/next() move time. */
  hold(): void {
    clockMode = 'held';
    heldIdleProbes = 0;
  },
  /**
   * THE ESCAPE HATCH: real time for the rest of this test. Only for a test whose subject IS real time;
   * `reason` says why, and scripts/validate/test-tiers.sh counts every call.
   */
  useRealTime(reason: string): void {
    if (reason.trim() === '') throw new Error('unitClock.useRealTime needs a reason');
    clockMode = 'real';
  },
};

const RealDate = Date;
const virtualNow = () => (clockMode === 'real' ? Reflect.apply(realDateNow, RealDate, []) : unitClock.now());
// `new Date()` reads whatever `Date.now` is installed when it is called, so a test that put a clock of
// its own in place (manual-clock.ts replaces `Date.now`) sees one time, not two.
const VirtualDate = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length === 0 ? [RealDate.now()] : args, newTarget);
  },
  apply() {
    return new RealDate(RealDate.now()).toString();
  },
});
const virtualPerformanceNow = () => (clockMode === 'real' ? realPerformanceNow() : PERFORMANCE_ORIGIN + elapsed);
const nanos = () => BigInt(PERFORMANCE_ORIGIN + elapsed) * 1_000_000n;
const virtualHrtime = Object.assign(
  (previous?: [number, number]) => {
    if (clockMode === 'real') return realHrtime(previous);
    const now = nanos() - (previous === undefined ? 0n : BigInt(previous[0]) * 1_000_000_000n + BigInt(previous[1]));
    return [Number(now / 1_000_000_000n), Number(now % 1_000_000_000n)];
  },
  { bigint: () => (clockMode === 'real' ? realHrtime.bigint() : nanos()) },
);
const virtualNanoseconds = () => (clockMode === 'real' ? realNanoseconds() : Number(nanos()));

const timers = require('node:timers');

/**
 * ANIMATION FRAMES, as a browser batches them. Every callback requested before a frame runs in that
 * frame, in request order, handed the frame's time. The first frame after a quiet spell is the next
 * immediate — ahead of any timer, as a browser paints before it runs timers, and happy-dom's own timing,
 * which the suite was written against; a callback requested FROM a frame
 * waits for the one after it, 16 virtual milliseconds later, so an animation loop (a drag that
 * auto-scrolls) moves time forward one frame at a time instead of spinning forever at one instant.
 * Both go through whatever `setTimeout` and `performance.now` are installed when it is called, so a
 * test that put a clock of its own in place (manual-clock.ts) draws its frames on that clock.
 */
const FRAME_MS = 16;
/** `FrameRequestCallback`, which this package's TypeScript library (no DOM) does not name. */
type FrameCallback = (time: number) => void;
let nextFrame = new Map<number, FrameCallback>();
let frameQueued = false;
let inFrame = false;
const runFrame = () => {
  frameQueued = false;
  const callbacks = nextFrame;
  nextFrame = new Map();
  const at = performance.now();
  inFrame = true;
  try {
    for (const callback of callbacks.values()) callback(at);
  } finally {
    inFrame = false;
  }
};
function virtualRequestAnimationFrame(callback: FrameCallback) {
  const id = nextId;
  nextId += 1;
  nextFrame.set(id, callback);
  if (!frameQueued) {
    frameQueued = true;
    if (inFrame) globalThis.setTimeout(runFrame, FRAME_MS);
    else globalThis.setImmediate(runFrame);
  }
  return id;
}
function virtualCancelAnimationFrame(handle: unknown) {
  nextFrame.delete(Number(handle));
}

/**
 * Puts the virtual clock in place — at load, and again before EVERY test. A test may install a clock
 * of its own (packages/pwa/tests/support/manual-clock.ts) and fail before restoring it; the next test,
 * in this file or the next, must not inherit a clock nothing moves.
 */
const installVirtualClock = () => {
  define(RealDate, 'now', virtualNow);
  globalThis.Date = VirtualDate;
  define(performance, 'now', virtualPerformanceNow);
  define(process, 'hrtime', virtualHrtime);
  define(Bun, 'nanoseconds', virtualNanoseconds);
  for (const owner of [globalThis, timers]) {
    define(owner, 'setTimeout', virtualSetTimeout);
    define(owner, 'setInterval', virtualSetInterval);
    define(owner, 'clearTimeout', virtualClear);
    define(owner, 'clearInterval', virtualClear);
    define(owner, 'setImmediate', trackedSetImmediate);
    define(owner, 'clearImmediate', trackedClearImmediate);
  }
  // happy-dom registers its window onto globalThis when a test file imports it, after this preload
  // loaded, so the frames are put back before every test as well.
  define(globalThis, 'requestAnimationFrame', virtualRequestAnimationFrame);
  define(globalThis, 'cancelAnimationFrame', virtualCancelAnimationFrame);
};
installVirtualClock();

const virtualSleep = (ms: unknown, value?: unknown) =>
  new Promise(resolve => {
    const wait = ms instanceof RealDate ? ms.getTime() - virtualNow() : ms;
    virtualSetTimeout(resolve, wait, value);
  });
define(Bun, 'sleep', (ms: unknown) => virtualSleep(ms));
refuse(Bun, 'sleepSync', 'timer', 'Bun.sleepSync()');
const timerPromises = require('node:timers/promises');
define(timerPromises, 'setTimeout', (ms: unknown, value?: unknown) => virtualSleep(ms, value));
define(timerPromises, 'setImmediate', (value?: unknown) => new Promise(resolve => trackedSetImmediate(resolve, value)));
define(AbortSignal, 'timeout', (ms: number) => {
  const controller = new AbortController();
  virtualSetTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  return controller.signal;
});

// Off-thread work the clock must not outrun.
trackPromises(globalThis.crypto?.subtle, [
  'encrypt',
  'decrypt',
  'sign',
  'verify',
  'digest',
  'generateKey',
  'deriveKey',
  'deriveBits',
  'importKey',
  'exportKey',
  'wrapKey',
  'unwrapKey',
]);
trackPromises(require('node:fs/promises'), [
  'readFile',
  'writeFile',
  'appendFile',
  'readdir',
  'stat',
  'lstat',
  'mkdir',
  'rm',
  'rename',
  'open',
  'access',
  'copyFile',
  'mkdtemp',
  'realpath',
  'unlink',
  'chmod',
]);
trackPromises(Bun, ['write']);
// Reading a body is native work too: a stubbed fetch's Response settles on Bun's own schedule.
for (const Body of [globalThis.Response, globalThis.Request])
  trackPromises(Body?.prototype, ['text', 'json', 'arrayBuffer', 'blob', 'bytes', 'formData']);
trackPromises(globalThis.Blob?.prototype, ['text', 'arrayBuffer', 'bytes']);

/**
 * EVERY TEST STARTS AT {@link UNIT_CLOCK_ORIGIN}. Timers still waiting from an earlier test are KEPT,
 * moved so they are due as far ahead of the new start as they were of the old clock: a module-level
 * singleton (one shared ticker for the whole page, say) set its timer once and expects it to keep
 * coming, so dropping it would leave every later test's ticker silent for good — which is what dropping
 * them did. What a test leaves behind it still answers for: a held test that goes idle names it.
 */
beforeEach(() => {
  installVirtualClock();
  for (const timer of scheduled.values()) timer.at = Math.max(0, timer.at - elapsed);
  elapsed = 0;
  generation += 1;
  offThread = 0;
  offThreadWork.clear();
  immediates = 0;
  inFlight = zeroTasks.size;
  nextFrame = new Map();
  frameQueued = false;
  clockMode = 'auto';
  idleProbes = 0;
  heldIdleProbes = 0;
  startProbing();
});
afterEach(() => {
  clockMode = 'auto';
});

// ─── the outside world ───────────────────────────────────────────────────────────────────────────

/** `data:`/`blob:` never leave the process; the hosts offline-environment.ts refuses never reach the network. */
const stays = (href: string) => {
  if (/^(data|blob):/u.test(href)) return true;
  try {
    return FORBIDDEN_TEST_HOST.test(new URL(href).hostname);
  } catch {
    return false;
  }
};
refuse(globalThis, 'fetch', 'socket', 'a real fetch', args => {
  const input = args[0];
  return !stays(input instanceof Request ? input.url : String(input));
});
refuseConstruction(globalThis, 'WebSocket', 'socket', 'a real WebSocket');
const net = require('node:net');
for (const name of ['connect', 'createConnection', 'createServer']) refuse(net, name, 'socket', `net.${name}()`);
refuse(net.Socket.prototype, 'connect', 'socket', 'net.Socket#connect()');
refuse(net.Server.prototype, 'listen', 'socket', 'net.Server#listen()');
const tls = require('node:tls');
for (const name of ['connect', 'createServer']) refuse(tls, name, 'socket', `tls.${name}()`);
for (const module of ['node:http', 'node:https', 'node:http2']) {
  const http = require(module);
  for (const name of ['request', 'get', 'createServer', 'connect', 'createSecureServer'])
    refuse(http, name, 'socket', `${module.slice(5)}.${name}()`);
}
refuse(require('node:dgram'), 'createSocket', 'socket', 'dgram.createSocket()');
for (const name of ['serve', 'listen', 'connect', 'udpSocket']) refuse(Bun, name, 'socket', `Bun.${name}()`);

const childProcess = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  refuse(childProcess, name, 'process', `child_process.${name}()`);
refuse(Bun, 'spawn', 'process', 'Bun.spawn()');
refuse(Bun, 'spawnSync', 'process', 'Bun.spawnSync()');
refuseConstruction(globalThis, 'Worker', 'process', 'a Worker thread');
refuse(Bun, 'gc', 'gc', 'a synchronous Bun.gc(true)', args => args[0] === true);
refuseConstruction(require('node:worker_threads'), 'Worker', 'process', 'a worker_threads Worker');
