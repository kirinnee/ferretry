/**
 * A `disabled` block as the wire shows it (docs/disabling.md): the reason, `until` as an instant and
 * the switch that holds it. Pure.
 */
import { instantFromEpochMs } from '@ferretry/std';
import type { Disabled as DisabledView } from '../../../contract/index.ts';
import { type Disabled, disabledUntilMs } from '../account/disabled.ts';
import type { RuntimeDisable } from '../account/disabled-runtime.ts';

/** One block as the wire shows it, from the switch `source` it sits on. */
function disabledOf(block: Disabled, source: DisabledView['source']): DisabledView {
  const until = disabledUntilMs(block.until);
  return {
    ...(block.reason === undefined ? {} : { reason: block.reason }),
    ...(until === undefined ? {} : { until: instantFromEpochMs(until) }),
    source,
  };
}

/** A runtime's: its own block when it has one, else the login's it runs on. */
export function runtimeDisabledView(off: RuntimeDisable): DisabledView {
  return off.own === undefined ? disabledOf(off.login as Disabled, 'login') : disabledOf(off.own, 'runtime');
}
