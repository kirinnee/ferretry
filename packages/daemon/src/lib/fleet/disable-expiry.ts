/**
 * Switches itself back on (docs/disabling.md): a login or runtime disabled `until` a time must be
 * published available again when that time comes, with no edit. This holds ONE timer, set for the
 * earliest `until` still ahead; when it fires the fleet is republished and the next one is set.
 *
 * The clock and the timer are injected, so a test drives time by hand.
 */

/** The longest a timer may be set for (a 32-bit signed millisecond count); a later expiry re-arms on the way. */
export const MAX_TIMER_MS = 2_147_483_647;

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

  constructor(private readonly deps: DisableExpiryDeps) {}

  /** Re-read the earliest expiry and set the timer for it, dropping any earlier one. Never rejects. */
  async rearm(): Promise<void> {
    this.stop();
    const generation = this.#generation;
    const due = await this.deps.next().catch(() => undefined);
    // A newer rearm or a stop landed while this one was reading: it owns the timer now.
    if (due === undefined || generation !== this.#generation) return;
    const wait = Math.max(0, due - this.deps.now());
    this.#cancel = this.deps.setTimer(() => void this.#fire(due), Math.min(wait, MAX_TIMER_MS));
  }

  stop(): void {
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
