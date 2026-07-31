import type { FleetManifestAccount, FleetUsageProbe, FleetUsageProbeResult } from '@ferretry/fleet';

/**
 * The quota probe this host has when no provider probe is provisioned.
 *
 * The per-provider probes — the calls that ask Anthropic and OpenAI how much of a window an account
 * has spent — are not ported yet. Rather than report a fabricated 0%, this answers `unavailable`
 * with the reason, which is a state the usage contract already models and the rendering already
 * says out loud. Replace it, do not special-case around it.
 */
export class UnprovisionedUsageProbe implements FleetUsageProbe {
  static readonly REASON = 'no provider quota probe is provisioned on this host';

  probe(_account: FleetManifestAccount): Promise<FleetUsageProbeResult> {
    return Promise.resolve({
      usageBased: false,
      ok: false,
      unavailable: true,
      unavailableReason: UnprovisionedUsageProbe.REASON,
    });
  }
}

/** The wall clock the usage collector stamps a snapshot with. */
export class SystemUsageClock {
  now(): number {
    return Date.now();
  }
}
