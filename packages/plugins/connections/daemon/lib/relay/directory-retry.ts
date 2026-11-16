/**
 * ASKING THE RELAY DIRECTORY AGAIN, IN THE BACKGROUND, UNTIL IT ANSWERS.
 *
 * The directory used to be read once per boot. A network that was not up yet right after a restart
 * (or a timeout, or a 5xx) therefore left the daemon direct-only until the NEXT restart, while the
 * relay carrier itself redialled forever — the one-shot read was the only thing that never recovered.
 *
 * WHAT IS RETRIED AND WHAT IS NOT is decided once, by `classifyDirectoryOutcome` in `discovery.ts`:
 * only a failure that carries `retry` (the network, a timeout, 5xx, 429) comes here. An answer — the
 * relay switched off, a document this daemon cannot read, a 404, no origin — never does, because
 * asking again for an answer is how an emergency stop turns into a retry storm.
 *
 * BOOT NEVER WAITS. The first read stays the after-listen job; this is only a timer that fires later.
 * `stop()` cancels the pending timer and aborts the read in flight, and nothing fires after it: an
 * answer that arrives mid-stop is dropped on the floor, not applied to a daemon that is going away.
 *
 * THE DELAY is the relay carrier's equal-jitter shape (never below half the window, never above it),
 * with a window that starts at {@link DIRECTORY_RETRY_BASE_MS} and doubles to
 * {@link DIRECTORY_RETRY_CAP_MS}. The carrier's own helper does not fit — its ceiling is clamped to ten
 * seconds, right for redialling a socket and wrong for asking an HTTP service that may be down for a
 * while — so the same shape has its own numbers rather than a second kind of jitter:
 *
 * - 2 s first: "the network was not up yet" is the common case and should recover in seconds.
 * - doubling to 5 min: a real outage must not be asked about every few seconds by every daemon in the
 *   fleet, and five minutes is soon enough that nobody notices the relay arrived late.
 * - equal jitter: daemons restarted together do not retry in the same millisecond.
 */

import { isTransientAdvertisement, type RelayAdvertisement } from './discovery.ts';

/** The first retry window. */
export const DIRECTORY_RETRY_BASE_MS = 2_000;
/** The longest window, and the longest a server-sent `Retry-After` is honoured. */
export const DIRECTORY_RETRY_CAP_MS = 300_000;

/**
 * How long to wait before retry number `attempt` (1 is the first retry after the boot read failed).
 *
 * Total: an unusable `attempt` (NaN, below 1) is the first retry, an infinite one the longest window; an
 * unusable `random` is the bottom of the range. A `retryAfterMs` the directory sent raises the delay to
 * that value, never above the cap and never below the backoff, so a hostile or mistaken header cannot make
 * a daemon wait for a day nor ask sooner than it would have.
 */
export function directoryRetryDelayMs(attempt: number, random: number, retryAfterMs?: number): number {
  const step = Number.isNaN(attempt) ? 1 : Math.max(1, Math.floor(attempt));
  const windowMs = Math.min(DIRECTORY_RETRY_CAP_MS, DIRECTORY_RETRY_BASE_MS * 2 ** Math.min(step - 1, 30));
  const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  const backoff = Math.round(windowMs / 2 + (windowMs / 2) * jitter);
  if (retryAfterMs === undefined || Number.isNaN(retryAfterMs)) return backoff;
  return Math.max(backoff, Math.min(DIRECTORY_RETRY_CAP_MS, Math.max(0, retryAfterMs)));
}

/** What the retry needs from the world, all injected so no suite waits or dials. */
export interface DirectoryRetryPorts {
  /** One read of the directory; `signal` aborts it when the daemon stops. */
  read(signal: AbortSignal): Promise<RelayAdvertisement>;
  /** A timer; returns its cancel. */
  after(ms: number, fn: () => void): () => void;
  random(): number;
  nowMs(): number;
  /**
   * False once the relay configuration is no longer the one the boot resolved (a relay written, a discovery entry
   * switched off or removed, anything else changed, or a configuration that cannot be read): asking stops and
   * nothing is applied. Asked before every read and again when one answers.
   */
  stillNeeded(): boolean;
}

/** What the retry reports. Each is called at most once per outcome and never after `stop()`. */
export interface DirectoryRetryEvents {
  /** The read failed again; the answer carries when the next try is. */
  waiting(failed: RelayAdvertisement): void;
  /** A definitive answer arrived (an advertised relay, a withdrawal, an unreadable document): asking is over. */
  settled(answer: RelayAdvertisement): void;
  /** Nothing needs the directory any more; asking stopped without applying anything. */
  abandoned(): void;
}

/** `HH:MM:SSZ` for an instant: the part of the day a reader can compare to their own clock. */
function timeOfDay(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 19)}Z`;
}

export class RelayDirectoryRetry {
  #attempt = 0;
  #cancel: (() => void) | undefined;
  #inFlight: AbortController | undefined;
  #over = false;

  constructor(
    private readonly ports: DirectoryRetryPorts,
    private readonly events: DirectoryRetryEvents,
  ) {}

  /**
   * Schedules the first retry for a transient failure of the boot read, and returns that failure
   * annotated with when the next try is. Calling it again, or after `stop()`, schedules nothing.
   */
  begin(failed: RelayAdvertisement): RelayAdvertisement {
    return this.#schedule(failed);
  }

  /** Cancels the pending timer, aborts the read in flight and drops whatever it answers. Idempotent. */
  stop(): void {
    this.#over = true;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#inFlight?.abort();
  }

  #schedule(failed: RelayAdvertisement): RelayAdvertisement {
    if (this.#over || this.#cancel !== undefined) return failed;
    this.#attempt += 1;
    const hint = isTransientAdvertisement(failed) ? failed.retry.retryAfterMs : undefined;
    const delay = directoryRetryDelayMs(this.#attempt, this.ports.random(), hint);
    this.#cancel = this.ports.after(delay, () => {
      void this.#ask();
    });
    if (failed.kind !== 'undetermined') return failed;
    return { ...failed, retry: { ...failed.retry, nextAt: timeOfDay(this.ports.nowMs() + delay) } };
  }

  async #ask(): Promise<void> {
    this.#cancel = undefined;
    if (this.#over) return;
    if (!this.ports.stillNeeded()) return this.#abandon();
    const controller = new AbortController();
    this.#inFlight = controller;
    let answer: RelayAdvertisement;
    try {
      answer = await this.ports.read(controller.signal);
    } catch {
      answer = { kind: 'undetermined', reason: 'this daemon could not reach the relay directory', retry: {} };
    }
    this.#inFlight = undefined;
    if (this.#over) return;
    if (!this.ports.stillNeeded()) return this.#abandon();
    if (isTransientAdvertisement(answer)) {
      this.events.waiting(this.#schedule(answer));
      return;
    }
    this.#over = true;
    this.events.settled(answer);
  }

  #abandon(): void {
    this.#over = true;
    this.events.abandoned();
  }
}
