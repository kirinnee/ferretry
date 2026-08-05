import type { FleetConfig, FleetUsageSnapshot } from '@ferretry/fleet';
import type { AccountUsage } from '@ferretry/protocol';
import type { AccountInventoryPort } from '../../lib/core/inventory.ts';
import { accountUsageFromFleet, type UsageSourcePort } from '../../lib/usage/index.ts';

/**
 * The two things this source asks of the fleet subsystem.
 *
 * Narrow on purpose: the collector is assembled per call from the declared configuration, the
 * manifest and this host's provider probe, and every one of those decisions belongs to the fleet
 * mount that already owns `GET /v1/fleet/usage`. Reaching for the whole subsystem here would invite
 * a second collector assembled with different thresholds, which is exactly how the route and
 * `fy fleet usage` would come to disagree about whether an account has quota left.
 */
export interface FleetUsageReader {
  config(): Promise<FleetConfig>;
  usage(): Promise<FleetUsageSnapshot>;
}

/**
 * The daemon's native account-health source: the same collector `GET /v1/fleet/usage` serves,
 * joined to the manifest and mapped into the feed's rows.
 *
 * Wired ahead of the collector-endpoint and command sources, so `/usage`, `/v1/usage` and `/metrics`
 * carry numbers this host asked the provider for rather than numbers another tool was asked for.
 *
 * A failure is `undefined`, never `[]`. An unapplied fleet, an unreadable manifest and a refused
 * configuration all raise, and each of them means this source could not answer — not that the fleet
 * has no accounts. The feed retains its last good snapshot and tries the next source instead.
 */
export class FleetUsageSource implements UsageSourcePort {
  constructor(
    private readonly fleet: FleetUsageReader,
    private readonly inventory: AccountInventoryPort,
  ) {}

  async read(signal?: AbortSignal): Promise<readonly AccountUsage[] | undefined> {
    // Collecting is a fan-out of live provider calls, so an already-cancelled read is abandoned
    // before it starts one. The collector takes no signal of its own, which makes the check here the
    // only place a cancellation can be honoured at all.
    if (signal?.aborted === true) return undefined;
    try {
      // `usage.enabled: false` turns off UNATTENDED collection, which is what this source is: the
      // feed collects on its own behalf, on a cadence nobody asked for at that moment. It reached
      // nothing before — parsed, defaulted to true and dropped — so an operator who switched quota
      // probing off still had a daemon probing every provider on a timer. `fy fleet usage` and
      // `GET /v1/fleet/usage` are unaffected, because a person asking is not a background cycle.
      //
      // Read per refresh rather than at boot: the configuration is edited and applied live, and a
      // daemon that had to be restarted to have quota probing switched back on would be its own bug.
      if (!(await this.fleet.config()).usage.enabled) return undefined;
      const [snapshot, accounts] = await Promise.all([this.fleet.usage(), this.inventory.accounts()]);
      return accountUsageFromFleet(snapshot, accounts);
    } catch {
      return undefined;
    }
  }
}
