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
 *
 * WHEN IT RUNS is its schedule's to say (docs/design/housekeeping-worker.md §3.2): the fleet reading
 * arms it for the moment a credential's active free read falls due, and the pass observes only the
 * credentials that are due. Everything else a pass used to re-read on its timer now arrives as an event.
 */
export interface FleetRefreshLoop {
  /** One pass, queued behind any pass already in flight. It never rejects from background work. */
  run(): Promise<void>;
  /**
   * Calls `due` whenever a pass is due — at once, then as the schedule says — until the answer is
   * called. Without a schedule nothing is due: a daemon that mounts none has no pass to arm.
   */
  arm(due: () => void): Promise<() => void>;
}

/** When passes are due, and which credentials each one observes. */
export interface FleetRefreshSchedule {
  /** Starts calling `due` whenever a credential falls due. */
  start(due: () => void): Promise<void>;
  /** The credentials due now: the ones a pass observes. */
  due(): readonly string[];
  /** A pass observed these. */
  observed(ids: readonly string[]): void;
  close(): void;
}

export interface FleetRefreshParts {
  readonly usage: UsageFeedPort;
  /**
   * The account model's credentials, observed on this SAME pass (docs/design/account-model.md
   * §8.1.3): each one's passive reading and, only when that is stale, its one free usage read. Never
   * a refresh and never a harness launch, which is what lets it ride an unattended timer at all.
   * `ids` names the credentials to observe; absent, every one.
   */
  readonly credentials?: { observeAll(ids?: readonly string[]): Promise<void> };
  /** Which credentials are due, and when. Absent: every pass observes every credential. */
  readonly schedule?: FleetRefreshSchedule;
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

  async arm(due: () => void): Promise<() => void> {
    const schedule = this.parts.schedule;
    if (schedule === undefined) return () => undefined;
    await schedule.start(due);
    return () => schedule.close();
  }

  private async refresh(): Promise<void> {
    // A collector failure is evidence that its existing feed should mark its prior snapshot stale,
    // never a reason to manufacture an empty fleet or to make the timer retry early. The schedule
    // chooses the next attempt; this pass only asks the established feed to refresh.
    const schedule = this.parts.schedule;
    const ids = schedule?.due();
    await Promise.allSettled([this.parts.usage.accounts(), this.parts.credentials?.observeAll(ids)]);
    if (schedule !== undefined && ids !== undefined) schedule.observed(ids);
  }
}
