/**
 * ASKING THE RELAY DIRECTORY AGAIN, IN THE BACKGROUND, AFTER A FAILED BOOT-TIME READ.
 *
 * The advertisement is read once while the daemon boots, and a daemon that boots right after a restart
 * or a login can be up before its network is. Until this existed that one failed read meant direct-only
 * until the NEXT restart, which is the same outcome as the operator withdrawing the relay and is
 * indistinguishable from it to the person whose browser cannot connect. The relay SOCKET already redials
 * with a jittered backoff; the lookup that decides whether there is a socket at all is what this gives
 * the same treatment.
 *
 * ONLY A TRANSIENT FAILURE IS ASKED AGAIN. A refusal to answer, a timeout and a 5xx are conditions that
 * change by themselves; an advertisement that says disabled, one this daemon cannot read, a build with
 * no directory and an explicit `relay` block are ANSWERS, and asking an answer again is how an emergency
 * stop turns into a suggestion. The distinction is carried on the advertisement by the adapter that saw
 * the failure ({@link isTransientAdvertisement}); this class never guesses it.
 *
 * ONE LOOP, ONE TIMER. The next wait is armed only after the previous read has finished, so there is no
 * second request in flight and no pile-up however slow the directory is, and the wait is capped so a
 * daemon whose directory is down for a day asks once every few minutes and not more often.
 *
 * IT NEVER STARTS A CARRIER ITSELF. It settles with the answer and the number of attempts, and whoever
 * owns the carriers decides what that means — which keeps the timing testable without a socket.
 */

import { backoffDelayMs, type BackoffPolicy } from '../tunnel/schedule.ts';
import type { RelayLinkScheduler, RelayLinkTimer } from './link.ts';
import type { RelayAdvertisement, RelayCarrierSource } from './discovery.ts';

/** 2 s for the first wait, doubling to a 300 s ceiling — the same numbers as the 5.0 daemon. Equal jitter is applied by {@link backoffDelayMs}. */
export const RELAY_LOOKUP_RETRY_BACKOFF: BackoffPolicy = Object.freeze({ baseMs: 2_000, capMs: 300_000 });

/** How long the directory asked to be left alone (`Retry-After`, in seconds, read as ms), if it said. */
export function retryAfterOf(advertisement: RelayAdvertisement): number | undefined {
  return advertisement.kind === 'undetermined' ? advertisement.retryAfterMs : undefined;
}

/** Whether asking the directory again could change the answer. Only a failure marked transient can. */
export function isTransientAdvertisement(advertisement: RelayAdvertisement): boolean {
  return advertisement.kind === 'undetermined' && advertisement.transient === true;
}

/**
 * What the loop ended with: the first answer that is not a transient failure, and how many reads it took
 * counting the boot's own failed read as the first.
 */
export interface RelayLookupSettled {
  readonly advertisement: RelayAdvertisement;
  readonly attempts: number;
}

export interface RelayLookupRetryOptions {
  readonly directory: { read(): Promise<RelayAdvertisement> };
  readonly scheduler: RelayLinkScheduler;
  readonly random: () => number;
  readonly backoff?: BackoffPolicy;
  /** Called at most once, never after {@link RelayLookupRetry.stop}. */
  readonly onSettled: (result: RelayLookupSettled) => void | Promise<void>;
}

export class RelayLookupRetry {
  readonly #options: RelayLookupRetryOptions;
  #timer: RelayLinkTimer | undefined;
  #started = false;
  #stopped = false;
  /** Reads made by this loop; the boot's failed read that started it is attempt 1. */
  #retries = 0;

  constructor(options: RelayLookupRetryOptions) {
    this.#options = options;
  }

  /**
   * Arms the first wait; `retryAfterMs` is what the failed boot-time read's `Retry-After` asked for, if
   * anything. A second call, or a call after {@link stop}, does nothing.
   */
  start(retryAfterMs?: number): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#arm(retryAfterMs);
  }

  /** Cancels the pending wait and makes any read still in flight settle into nothing. Idempotent. */
  stop(): void {
    this.#stopped = true;
    this.#timer?.cancel();
    this.#timer = undefined;
  }

  /**
   * The wait before the next read: the jittered backoff, but never sooner than the directory itself asked
   * for with `Retry-After` — and never longer than the cap, so one odd header cannot park the loop for a day.
   */
  #arm(retryAfterMs?: number): void {
    const policy = this.#options.backoff ?? RELAY_LOOKUP_RETRY_BACKOFF;
    const backoff = backoffDelayMs(policy, this.#retries, this.#options.random);
    const delay = Math.min(policy.capMs, Math.max(backoff, retryAfterMs ?? 0));
    this.#timer = this.#options.scheduler.after(delay, () => {
      this.#timer = undefined;
      void this.#attempt();
    });
  }

  async #attempt(): Promise<void> {
    if (this.#stopped) return;
    this.#retries += 1;
    let advertisement: RelayAdvertisement;
    try {
      advertisement = await this.#options.directory.read();
    } catch {
      // The port promises never to throw; a breach is a failed read, not the end of the loop.
      advertisement = { kind: 'undetermined', reason: 'the relay directory read failed', transient: true };
    }
    if (this.#stopped) return;
    if (isTransientAdvertisement(advertisement)) {
      this.#arm(retryAfterOf(advertisement));
      return;
    }
    this.#stopped = true;
    try {
      await this.#options.onSettled({ advertisement, attempts: this.#retries + 1 });
    } catch {
      // Whoever owns the carriers reports its own failure; this loop has nothing further to do.
    }
  }
}

/**
 * The sources a recovered lookup newly turned into a discovered relay: direct-only before, discovered
 * now, by position. A configured relay, and a discovery entry that was already dialling, are never in it,
 * which is what stops a recovery from dialling anything twice.
 */
export function newlyDiscoveredRelays(
  before: readonly RelayCarrierSource[],
  after: readonly RelayCarrierSource[],
): readonly RelayCarrierSource[] {
  return after.filter((source, index) => source.kind === 'discovered' && before[index]?.kind === 'direct-only');
}
