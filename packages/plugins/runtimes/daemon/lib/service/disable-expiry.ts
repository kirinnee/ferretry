/**
 * Switches itself back on (docs/disabling.md): a login or runtime disabled `until` a time must be
 * published available again when that time comes, with no edit. This holds ONE timer, set for the
 * earliest `until` still ahead; when it fires the fleet is republished and the next one is set.
 *
 * The clock and the timer are injected, so a test drives time by hand.
 */

import { disabledUntilMs, nextDisableExpiry } from '../account/disabled.ts';

/** The longest a timer may be set for (a 32-bit signed millisecond count); a later expiry re-arms on the way. */
const MAX_TIMER_MS = 2_147_483_647;

export interface DisableExpiryDeps {
  /** The earliest `until` still ahead (ms), or `undefined` when none will fall due. */
  next(): Promise<number | undefined>;
  now(): number;
  /** Publish the fleet again so the switch that expired reads as on. */
  republish(): Promise<void>;
  setTimer(run: () => void, ms: number): () => void;
}

export class DisableExpiryWatch {
  #cancel: (() => void) | undefined;
  #generation = 0;
  #stopped = false;

  constructor(private readonly deps: DisableExpiryDeps) {}

  /** Re-read the earliest expiry and set the timer for it, dropping any earlier one. Never rejects; after `stop`, does nothing. */
  async rearm(): Promise<void> {
    this.#drop();
    if (this.#stopped) return;
    const generation = this.#generation;
    const due = await this.deps.next().catch(() => undefined);
    // A newer rearm or a stop landed while this one was reading: it owns the timer now.
    if (due === undefined || generation !== this.#generation) return;
    const wait = Math.max(0, due - this.deps.now());
    this.#cancel = this.deps.setTimer(() => void this.#fire(due), Math.min(wait, MAX_TIMER_MS));
  }

  /** Drop the timer for good: a later `rearm`, or one a firing timer would make, sets none. */
  stop(): void {
    this.#stopped = true;
    this.#drop();
  }

  #drop(): void {
    this.#generation += 1;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  async #fire(due: number): Promise<void> {
    this.#cancel = undefined;
    // A timer clamped to the 32-bit limit fires early: not due yet, so wait again.
    if (this.deps.now() < due) return await this.rearm();
    await this.deps.republish().catch(() => undefined);
    await this.rearm();
  }
}

/** A runtime or login `disabled` block, as much of it as the timer reads. */
interface DisabledBlockOf {
  readonly disabled?: { readonly until?: string | undefined } | undefined;
}

/** A runtime file, as much of it as the timer reads: its own block and the login it runs on. */
interface RuntimeBlockOf extends DisabledBlockOf {
  readonly login: string;
}

/** The earliest `until` (ms) still ahead of `now` among the runtimes and the logins, or `undefined` when none will fall due. */
export function earliestExpiry(
  runtimes: ReadonlyMap<string, DisabledBlockOf>,
  logins: ReadonlyMap<string, DisabledBlockOf>,
  now: number,
): number | undefined {
  return nextDisableExpiry(
    [...runtimes.values(), ...logins.values()].map(file => file.disabled),
    now,
  );
}

/** The names whose `until` fell due after `after` and by `upTo` (ms): the switches that just came back on. Sorted. */
export function expiredBetween(
  files: ReadonlyMap<string, DisabledBlockOf>,
  after: number,
  upTo: number,
): readonly string[] {
  return [...files]
    .filter(([, file]) => {
      const until = disabledUntilMs(file.disabled?.until);
      return until !== undefined && until > after && until <= upTo;
    })
    .map(([name]) => name)
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * The runtimes that read differently once the window (`after`, `upTo`] has passed: those whose own `until` fell due in
 * it, and every runtime on a login whose `until` did. Sorted.
 */
export function runtimesBackOn(
  runtimes: ReadonlyMap<string, RuntimeBlockOf>,
  logins: ReadonlyMap<string, DisabledBlockOf>,
  after: number,
  upTo: number,
): readonly string[] {
  const own = expiredBetween(runtimes, after, upTo);
  const loginsBack = new Set(expiredBetween(logins, after, upTo));
  const viaLogin = [...runtimes].filter(([, file]) => loginsBack.has(file.login)).map(([name]) => name);
  return [...new Set([...own, ...viaLogin])].toSorted((left, right) => left.localeCompare(right));
}
