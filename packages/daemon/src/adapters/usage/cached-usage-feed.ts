import type { AccountUsage } from '@ferretry/protocol';
import {
  USAGE_REFRESH_MS,
  cachedAccounts,
  decideUsageRead,
  emptyUsageCache,
  recordUsageRefresh,
  type UsageCacheState,
  type UsageFeedPort,
  type UsageSourcePort,
} from '../../lib/usage/index.ts';

export interface CachedUsageFeedOptions {
  readonly now?: () => number;
  readonly refreshMs?: number;
}

/**
 * The daemon-wide account-health feed: one cached snapshot, one in-flight refresh shared by every
 * concurrent reader, and a failed refresh that retains the last good snapshot instead of reporting
 * an empty fleet.
 *
 * Sources are tried in order and the first that returns accounts wins, which is how an HTTP
 * collector falls back to a command without either one knowing about the other.
 */
export class CachedUsageFeed implements UsageFeedPort {
  private state: UsageCacheState = emptyUsageCache;
  private pending?: Promise<readonly AccountUsage[]>;
  private readonly clock: () => number;
  private readonly refreshMs: number;

  constructor(
    private readonly sources: readonly UsageSourcePort[],
    options: CachedUsageFeedOptions = {},
  ) {
    this.clock = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? USAGE_REFRESH_MS;
  }

  hasSnapshot(): boolean {
    return this.state.snapshot !== undefined;
  }

  /**
   * Epoch ms of the last successful refresh, or `undefined` before the first. Clients surface it so
   * the numbers read as "as of …" rather than implying they are live.
   */
  snapshotAt(): number | undefined {
    return this.state.snapshot?.at;
  }

  /**
   * A read never resolves to an empty list on the strength of a failure: emptiness is a claim about
   * the fleet, and a cancelled read or a dead collector is not evidence for it. Every path answers
   * from the cache, which {@link recordUsageRefresh} only ever replaces with a successful reading —
   * so the source's "return `[]` when the read was cancelled", indistinguishable from "every account
   * vanished", is unrepresentable rather than merely avoided.
   *
   * An already-aborted caller skips the probe entirely; one aborted mid-flight still gets the
   * snapshot, because the refresh it was waiting on has already folded itself into the cache.
   */
  async accounts(signal?: AbortSignal): Promise<readonly AccountUsage[]> {
    if (signal?.aborted === true) return cachedAccounts(this.state);
    const decision = decideUsageRead(this.state, this.clock(), this.refreshMs);
    if (decision.kind === 'serve') return decision.accounts;

    const pending = this.pending ?? this.refresh(signal);
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  /** Reads the sources in order and folds the outcome into the cache, which it then answers from. */
  private async refresh(signal?: AbortSignal): Promise<readonly AccountUsage[]> {
    let firstDefined: readonly AccountUsage[] | undefined;
    for (const source of this.sources) {
      const accounts = await source.read(signal).catch(() => undefined);
      if (accounts === undefined) continue;
      if (accounts.length > 0) {
        firstDefined = accounts;
        break;
      }
      firstDefined ??= accounts;
    }
    this.state = recordUsageRefresh(this.state, firstDefined, this.clock(), this.refreshMs);
    return cachedAccounts(this.state);
  }
}
