import type { UsageFeedPort } from '../usage/types.ts';

/**
 * The mounted, daemon-scoped pass that keeps fleet evidence warm while the daemon is supervised.
 *
 * This deliberately drives the existing feed instead of maintaining another cache: `UsageFeedPort`
 * coalesces concurrent reads and preserves its last good snapshot. One instance is constructed per
 * daemon state home, so no pending work or failure from one daemon can affect another daemon's
 * refresh cadence.
 *
 * WHAT THIS PASS MAY NOT DO: spend money. It ran the fleet health probe until it was removed here,
 * and that probe LAUNCHES an account's wrapper and asks a model to answer a sentinel prompt — a real
 * billable turn, per account, on the daemon's fixed timer, whether or not anybody was watching. The
 * `health.enabled` flag was supposed to prevent it and did not, which is why the rule is now
 * structural rather than conditional: an unattended pass reaches the usage feed, and the usage feed
 * reads only. A health probe is a deliberate act with a cost, so it belongs where somebody chose it.
 */
export interface FleetRefreshLoop {
  /** One pass, queued behind any pass already in flight. It never rejects from background work. */
  run(): Promise<void>;
}

export interface FleetRefreshParts {
  readonly usage: UsageFeedPort;
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
    // daemon timer chooses the next attempt; this pass only asks the established feed to refresh.
    await Promise.allSettled([this.parts.usage.accounts()]);
  }
}
