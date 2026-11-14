import type { DoctorFinding } from '@ferretry/kernel/contract';
import type { DoctorRun } from '@ferretry/kernel/manifest';
import { LOOPBACK_FIREWALL_MARKER_PATH } from '../wire/ports.ts';
import type { LoopbackFirewallState } from '../wire/firewall.ts';

const SUMMARIES: Record<Exclude<LoopbackFirewallState['state'], 'applied'>, string> = {
  failed: 'the last check reached this account’s ports from another user',
  missing: `no firewall rule for this account in the marker at ${LOOPBACK_FIREWALL_MARKER_PATH}`,
  stale: 'the marker does not list this account’s ports',
  unverified: 'the 5-minute firewall check is not running',
};

/**
 * THE `loopback firewall` DOCTOR ROW (today's `loopbackFirewall`, `daemon/src/lib/core/doctor.ts`): whether the
 * root-installed rule fences this account's fixed browser ports from other local users.
 *
 * A WARNING, never a gate: a browser still starts without the firewall, so the report's readiness ignores it. No row
 * while the ports are random (nothing to fence) or the setting cannot be read: `read` answers `undefined`, and the
 * check says nothing rather than guess.
 */
export function loopbackFirewallDoctor(read: () => Promise<LoopbackFirewallState | undefined>): DoctorRun {
  return async (): Promise<DoctorFinding | undefined> => {
    let state: LoopbackFirewallState | undefined;
    try {
      state = await read();
    } catch {
      return undefined;
    }
    if (state === undefined) return undefined;
    const base = { name: 'loopback firewall', requirement: 'capability' } as const;
    if (state.state === 'applied')
      return {
        ...base,
        state: 'ok',
        detail: 'applied',
        fix: 'Other users on this host cannot reach this account’s browser ports.',
      };
    return { ...base, state: 'warn', detail: SUMMARIES[state.state], fix: state.detail };
  };
}
