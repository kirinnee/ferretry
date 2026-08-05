import type { UsageFeedPort } from '../usage/types.ts';

/** The fleet evidence that an unattended pass can refresh without knowing how either collector works. */
export interface FleetRefreshTarget {
  /** Refreshes the daemon-owned health snapshot, retaining its last good result on failure. */
  health(): Promise<unknown>;
}

/**
 * The mounted, daemon-scoped pass that keeps fleet evidence warm while the daemon is supervised.
 *
 * This deliberately drives the existing feeds instead of maintaining another cache: `UsageFeedPort`
 * coalesces concurrent reads and preserves its last good snapshot, while the fleet health target owns
 * the equivalent policy for its own evidence. One instance is constructed per daemon state home, so
 * no pending work or failure from one daemon can affect another daemon's refresh cadence.
 */
export interface FleetRefreshLoop {
  /** One pass, queued behind any pass already in flight. It never rejects from background work. */
  run(): Promise<void>;
}

export interface FleetRefreshParts {
  readonly usage: UsageFeedPort;
  readonly fleet: FleetRefreshTarget;
}

export class FleetRefreshService implements FleetRefreshLoop {
  /** A settled tail serializes ticks without allowing one failed collector to poison the next tick. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly parts: FleetRefreshParts) {}

  async run(): Promise<void> {
    const queued = this.chain.then(async () => await this.refresh());
    this.chain = queued.then(
      () => undefined,
      () => undefined,
    );
    await this.chain;
  }

  private async refresh(): Promise<void> {
    // A collector failure is evidence that its existing feed should mark its prior snapshot stale,
    // never a reason to manufacture an empty fleet or to make the timer retry early. The fixed
    // daemon timer chooses the next attempt; this pass only asks each established feed to refresh.
    await Promise.allSettled([this.parts.usage.accounts(), this.parts.fleet.health()]);
  }
}
