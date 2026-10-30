/**
 * A `disabled` block as the wire shows it (docs/disabling.md): the reason, `until` as an instant and
 * the switch that holds it. Pure.
 */
import { type Disabled, disabledUntilMs, type RuntimeDisable } from '@ferretry/fleet';
import type { FleetDisabled } from '@ferretry/protocol';

/** One block as the wire shows it, from the switch `source` it sits on. */
export function disabledOf(block: Disabled, source: FleetDisabled['source']): FleetDisabled {
  const until = disabledUntilMs(block.until);
  return {
    ...(block.reason === undefined ? {} : { reason: block.reason }),
    ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
    source,
  };
}

/** A runtime's: its own block when it has one, else the login's it runs on. */
export function runtimeDisabledView(off: RuntimeDisable): FleetDisabled {
  return off.own === undefined ? disabledOf(off.login as Disabled, 'login') : disabledOf(off.own, 'runtime');
}
