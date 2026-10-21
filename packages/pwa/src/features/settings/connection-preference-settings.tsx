/**
 * Settings › This device › CONNECTION — which carriers this device walks to reach each paired machine
 * (`docs/relay-protocol.md` §15 "The choice").
 *
 * It is a THIS-DEVICE setting held per machine: the browser keeps it, keyed by each machine's
 * fingerprint, and never sends it — the daemon publishes the carriers it holds and the preference
 * only decides which of them this browser tries. So it lives here, one selector per machine, rather
 * than on a machine's own tab; the machine's Connection status carries the same selector for itself.
 */

import type { CarrierPreference } from '../../lib/carrier-preference.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import {
  type CarrierPreferenceAvailability,
  CarrierPreferenceSelector,
} from '../carrier/carrier-preference-selector.tsx';

/** One paired machine, as this list shows it. */
interface ConnectionPreferenceMachine {
  readonly daemonId: DaemonId;
  readonly label: string;
  readonly preference: CarrierPreference;
  readonly availability: CarrierPreferenceAvailability;
}

export interface ConnectionPreferenceSettingsProps {
  readonly machines: readonly ConnectionPreferenceMachine[];
  readonly onChange: (daemonId: DaemonId, preference: CarrierPreference) => void;
}

/** Said with no machine paired, so the section is never an empty box. */
export const NO_MACHINES_TO_CONNECT = 'Pair a machine to choose how this device reaches it.';

export function ConnectionPreferenceSettings({ machines, onChange }: ConnectionPreferenceSettingsProps) {
  if (machines.length === 0) return <p className="m-0 text-cell leading-base text-muted">{NO_MACHINES_TO_CONNECT}</p>;
  return (
    <div className="flex flex-col gap-5" data-connection-preferences="">
      {machines.map(machine => (
        <CarrierPreferenceSelector
          key={machine.daemonId}
          legend={machine.label}
          value={machine.preference}
          onChange={preference => onChange(machine.daemonId, preference)}
          availability={machine.availability}
        />
      ))}
      <p className="m-0 text-meta leading-base text-faint">
        Kept on this device for each machine, and never sent to it. Pairing a new device is always direct first,
        whatever is chosen here.
      </p>
    </div>
  );
}
