/**
 * Settings › This device › CONNECTION — which carriers this device walks to reach each paired machine
 * (`docs/relay-protocol.md` §15 "The choice").
 *
 * It is a THIS-DEVICE setting held per machine: the browser keeps it, keyed by each machine's
 * fingerprint, and never sends it — the daemon publishes the carriers it holds and the preference
 * only decides which of them this browser tries. So it lives here, one row per machine, rather
 * than on a machine's own tab; the machine's Connection status carries the same selector for itself.
 *
 * Each row is the machine's name, what its current choice does in one line, and a segmented
 * Auto / WebRTC / Tunnel / Relay control. A choice that can carry nothing right now says why in the row, and a
 * tunnel switched off is offered, once, under it.
 */

import { CARRIER_PREFERENCE_LABEL, CARRIER_PREFERENCES, type CarrierPreference } from '../../lib/carrier-preference.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import {
  CARRIER_PREFERENCE_DESCRIPTION,
  type CarrierPreferenceAvailability,
  noteFor,
  TunnelOffer,
  walksTunnel,
} from '../carrier/carrier-preference-selector.tsx';
import { Segmented, SettingRow } from './setting-row.tsx';
import { settingDefinition } from './settings-catalog.ts';

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

const CONNECTION_EXPLANATION = `${settingDefinition('connection-preference').description} Kept on this device for each machine, and never sent to it. Pairing a new device is always direct first, whatever is chosen here.`;

const OPTIONS = CARRIER_PREFERENCES.map(id => ({
  id,
  label: CARRIER_PREFERENCE_LABEL[id],
  title: CARRIER_PREFERENCE_DESCRIPTION[id],
}));

/** The rows of the Connection group: one per machine, or the line that says there is none. */
export function ConnectionPreferenceSettings({ machines, onChange }: ConnectionPreferenceSettingsProps) {
  if (machines.length === 0) return <SettingRow name="Connection" hint={NO_MACHINES_TO_CONNECT} />;
  return (
    <>
      {machines.map(machine => {
        const note = noteFor(machine.preference, machine.availability);
        return (
          <SettingRow
            key={machine.daemonId}
            name={machine.label}
            hint={CARRIER_PREFERENCE_DESCRIPTION[machine.preference]}
            explanation={CONNECTION_EXPLANATION}
            wide
            control={() => (
              <Segmented
                label={`${machine.label}: how this device connects`}
                value={machine.preference}
                options={OPTIONS}
                onChange={preference => onChange(machine.daemonId, preference)}
              />
            )}
          >
            <div data-carrier-preference={machine.preference}>
              {note === undefined ? null : (
                <p className="m-0 px-panel pb-2 text-meta leading-tight text-warn" data-carrier-preference-note="">
                  {note}
                </p>
              )}
              {machine.availability.tunnel?.off === true && walksTunnel(machine.preference) ? (
                <div className="px-panel pb-3">
                  <TunnelOffer offer={machine.availability.tunnel} />
                </div>
              ) : null}
            </div>
          </SettingRow>
        );
      })}
    </>
  );
}
