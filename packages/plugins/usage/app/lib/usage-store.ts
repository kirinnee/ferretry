/**
 * THE ACCOUNT-USAGE FEED CACHE, ONE SLICE PER PAIRED DAEMON.
 *
 * Ported from the usage half of kteam `ui/src/lib/store.tsx` — the part
 * `ui/src/hooks/useUsage.ts` was reduced to reading. Its header records why the
 * poll moved into the store and must stay there: the hook used to own a 60s
 * interval, so ONE INTERVAL RAN PER MOUNTED CONSUMER. With the dashboard kept
 * mounted behind a session and two retained chat panes, three components asked
 * the daemon the same fleet-wide question every minute, forever. `watch()`
 * below is refcounted for exactly that reason — the fourth consumer costs
 * nothing, and the timer stops when the last one leaves.
 *
 * WHAT CHANGED FOR FERRETRY. kteam kept one feed for the whole app because
 * there was only ever one daemon. Agent wrapper names are per-machine
 * identifiers: two paired daemons both have a `claude` wrapper, at unrelated
 * quota. `lib/usage.ts` already fixed the lookup — every read requires a
 * `DaemonId` — and this module fixes the FETCH half the same way. Each daemon
 * has its own slice, its own status, its own timer refcount, and no read here
 * accepts a bare agent name.
 *
 * WHAT IS KEPT FROM THE ORIGINAL, DELIBERATELY:
 *
 *   - LAST-GOOD ON FAILURE. A failed poll sets `status: 'error'` and leaves the
 *     previous feed in place. Blanking it would turn "we could not reach the
 *     daemon" into "this account has no quota", which is a different and
 *     confident claim the daemon never made.
 *   - A MALFORMED FEED IS A FAILED READ, not an empty one. `DaemonUsageIndex`
 *     rejects it whole; a partial feed would read as "no quota" for every row
 *     that failed to parse.
 *   - THE VISIBILITY GATE. A hidden tab does not poll. The first read after a
 *     `watch()` is unconditional, because a consumer that just mounted needs an
 *     answer whether or not the tab is foreground at that instant.
 *
 * GENERATIONS. The shell builds a half once per daemon and drops it when the daemon is unpaired, so a store
 * belongs to one client; `clearDaemon` replaces the entry, and an in-flight read that finds its entry replaced
 * publishes nothing.
 */

import type { UsageFeedView } from '../../contract/index.ts';
import { browserClock, type DaemonConnection, type DaemonId, type UsageClient } from '../shell.ts';
import { DaemonUsageIndex, type QuotaSubject, type ResolvedQuota } from './usage.ts';

/**
 * Quota moves over minutes and the upstream feed is itself daemon-cached, so a meter two minutes old is
 * still the right meter. It is read once per machine shown, which made kteam's sixty seconds a
 * steady share of an idle page's traffic.
 */
export const USAGE_POLL_MS = 120_000;

type UsageLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * One daemon's account feed as a screen renders it.
 *
 * `feed` is `null` until a read succeeds, which is a different fact from an
 * empty `accounts` array: the first means "not read yet", the second means
 * "this daemon manages no accounts with a quota window".
 */
export interface DaemonUsageSlice {
  readonly feed: UsageFeedView | null;
  readonly status: UsageLoadStatus;
  /** The last failed answer. It survives into the next `loading`, because a
   *  pending retry does not make the previous failure untrue. */
  readonly error: string | null;
}

export interface UsageSnapshot {
  readonly daemons: ReadonlyMap<DaemonId, DaemonUsageSlice>;
}

/** The one daemon read this store needs, injected rather than imported. */
export interface DaemonUsagePort {
  usage(daemon: DaemonConnection): Promise<unknown>;
}

/**
 * The browser port. It returns the parsed body UNVALIDATED on purpose:
 * `DaemonUsageIndex.apply` owns the schema, so there is exactly one place that
 * decides what a readable feed is and one place that can reject a partial one.
 */
export const daemonUsagePort = (client: UsageClient): DaemonUsagePort => ({
  async usage(): Promise<unknown> {
    return await client.call('GET /v1/usage');
  },
});

export interface DaemonUsageStoreOptions {
  readonly pollMs?: number;
  /** Defaults to the document's own visibility; injected for tests. */
  readonly isHidden?: () => boolean;
}

const IDLE_SLICE: DaemonUsageSlice = Object.freeze({ feed: null, status: 'idle' as const, error: null });

const documentHidden = (): boolean => typeof document !== 'undefined' && document.hidden;

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

interface UsageEntry {
  readonly daemonId: DaemonId;
}

interface UsageWatch {
  count: number;
  daemon: DaemonConnection;
  /** Stops the shared poll. */
  readonly stop: () => void;
}

export class DaemonUsageStore {
  readonly #port: DaemonUsagePort;
  readonly #pollMs: number;
  readonly #isHidden: () => boolean;
  readonly #index = new DaemonUsageIndex();
  readonly #entries = new Map<DaemonId, UsageEntry>();
  readonly #slices = new Map<DaemonId, DaemonUsageSlice>();
  readonly #watches = new Map<DaemonId, UsageWatch>();
  readonly #listeners = new Set<() => void>();
  #snapshot: UsageSnapshot = { daemons: new Map() };

  constructor(port: DaemonUsagePort, options: DaemonUsageStoreOptions = {}) {
    this.#port = port;
    this.#pollMs = options.pollMs ?? USAGE_POLL_MS;
    this.#isHidden = options.isHidden ?? documentHidden;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): UsageSnapshot => this.#snapshot;

  /** One daemon's slice, or the shared idle value before its first read. */
  usage(daemonId: DaemonId): DaemonUsageSlice {
    return this.#slices.get(daemonId) ?? IDLE_SLICE;
  }

  /**
   * The quota to display for a session on this daemon, or `null` when nothing
   * is known about its wrapper. `null` means "no data" and must never be
   * rendered as zero percent.
   */
  quotaFor(daemonId: DaemonId, view: QuotaSubject): ResolvedQuota | null {
    return this.#index.quotaFor(daemonId, view);
  }

  /**
   * Reads one daemon's feed. Never rejects: a poll failure is a slice status,
   * not an exception a timer callback would drop on the floor anyway.
   */
  async refresh(daemon: DaemonConnection): Promise<boolean> {
    const entry = this.#entryFor(daemon);
    this.#patch(daemon.daemonId, { status: 'loading' });
    try {
      const value = await this.#port.usage(daemon);
      if (!this.#isCurrent(entry)) return false;
      if (!this.#index.apply(daemon.daemonId, value)) {
        this.#patch(daemon.daemonId, {
          status: 'error',
          error: 'the daemon returned an account feed this client cannot read',
        });
        return false;
      }
      this.#patch(daemon.daemonId, {
        feed: this.#index.feed(daemon.daemonId) ?? null,
        status: 'ready',
        error: null,
      });
      return true;
    } catch (reason) {
      if (!this.#isCurrent(entry)) return false;
      this.#patch(daemon.daemonId, { status: 'error', error: failureMessage(reason) });
      return false;
    }
  }

  /**
   * Registers one consumer of this daemon's feed and returns its release.
   *
   * The first consumer reads immediately and starts the shared timer; every
   * later one joins that timer and only refreshes the connection it polls
   * with, so a re-paired connection takes over rather than leaving a stale one
   * in the closure. The timer stops when the last consumer releases; the
   * release is idempotent so a double unmount cannot free another consumer's
   * hold.
   */
  watch(daemon: DaemonConnection): () => void {
    const id = daemon.daemonId;
    void this.refresh(daemon);
    const existing = this.#watches.get(id);
    if (existing !== undefined) {
      existing.count += 1;
      existing.daemon = daemon;
    } else {
      // biome-ignore lint/suspicious/useIterableCallbackReturn: `browserClock.every` is a repeating timer, not `Array.prototype.every`
      const stop = browserClock.every(() => {
        if (this.#isHidden()) return;
        const current = this.#watches.get(id);
        if (current !== undefined) void this.refresh(current.daemon);
      }, this.#pollMs);
      this.#watches.set(id, { count: 1, daemon, stop });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release(id);
    };
  }

  /** Drops one disconnected daemon's feed and leaves every other daemon's. */
  clearDaemon(daemonId: DaemonId): boolean {
    this.#index.clearDaemon(daemonId);
    this.#entries.delete(daemonId);
    const had = this.#slices.delete(daemonId);
    if (had) this.#publish();
    return had;
  }

  #release(daemonId: DaemonId): void {
    const watch = this.#watches.get(daemonId);
    if (watch === undefined) return;
    watch.count -= 1;
    if (watch.count > 0) return;
    watch.stop();
    this.#watches.delete(daemonId);
  }

  #entryFor(daemon: DaemonConnection): UsageEntry {
    const existing = this.#entries.get(daemon.daemonId);
    if (existing !== undefined) return existing;
    const entry: UsageEntry = { daemonId: daemon.daemonId };
    this.#entries.set(daemon.daemonId, entry);
    return entry;
  }

  #isCurrent(entry: UsageEntry): boolean {
    return this.#entries.get(entry.daemonId) === entry;
  }

  #patch(daemonId: DaemonId, patch: Partial<DaemonUsageSlice>): void {
    this.#slices.set(daemonId, { ...this.usage(daemonId), ...patch });
    this.#publish();
  }

  #publish(): void {
    this.#snapshot = { daemons: new Map(this.#slices) };
    for (const listener of this.#listeners) listener();
  }
}
