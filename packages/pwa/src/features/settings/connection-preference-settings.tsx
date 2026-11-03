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
 * Auto / WebRTC / Tunnel / Relay control. EVERY choice that can carry nothing right now says why in the row —
 * not only the selected one — and its radio is described by that sentence, so an unusable choice is known
 * before it is applied. What every choice does sits behind the (i). A tunnel switched off is offered, once,
 * under the row.
 */

import { useId } from 'react';
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

/** What each choice does, one per line: the row's hint names only the chosen one. */
const CHOICES_EXPLAINED = (
  <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0" data-option-notes="">
    {CARRIER_PREFERENCES.map(id => (
      <li key={id}>
        <span className="font-semibold text-fg">{CARRIER_PREFERENCE_LABEL[id]}</span> —{' '}
        {CARRIER_PREFERENCE_DESCRIPTION[id]}
      </li>
    ))}
  </ul>
);

/** One machine's row. A component of its own so each radio's reason gets an id that is unique on the page. */
function MachineConnectionRow({
  machine,
  onChange,
}: {
  readonly machine: ConnectionPreferenceMachine;
  readonly onChange: ConnectionPreferenceSettingsProps['onChange'];
}) {
  const id = useId();
  // Every choice that cannot carry anything right now, selected or not, with the reason it gives.
  const unusable = CARRIER_PREFERENCES.flatMap(preference => {
    const note = noteFor(preference, machine.availability);
    return note === undefined ? [] : [{ preference, note, noteId: `${id}-${preference}-note` }];
  });
  const options = CARRIER_PREFERENCES.map(preference => {
    const reason = unusable.find(entry => entry.preference === preference);
    return {
      id: preference,
      label: CARRIER_PREFERENCE_LABEL[preference],
      title: CARRIER_PREFERENCE_DESCRIPTION[preference],
      ...(reason === undefined ? {} : { describedBy: reason.noteId }),
    };
  });
  return (
    <SettingRow
      name={machine.label}
      hint={CARRIER_PREFERENCE_DESCRIPTION[machine.preference]}
      explanation={
        <>
          <p className="m-0">{CONNECTION_EXPLANATION}</p>
          {CHOICES_EXPLAINED}
        </>
      }
      wide
      control={() => (
        <Segmented
          label={`${machine.label}: how this device connects`}
          value={machine.preference}
          options={options}
          onChange={preference => onChange(machine.daemonId, preference)}
        />
      )}
    >
      <div data-carrier-preference={machine.preference}>
        {unusable.map(({ preference, note, noteId }) => (
          <p
            key={preference}
            id={noteId}
            className="m-0 px-panel pb-2 text-meta leading-tight text-warn"
            data-carrier-preference-note={preference}
          >
            <span className="font-semibold">{CARRIER_PREFERENCE_LABEL[preference]}:</span> {note}
          </p>
        ))}
        {machine.availability.tunnel?.off === true && walksTunnel(machine.preference) ? (
          <div className="px-panel pb-3">
            <TunnelOffer offer={machine.availability.tunnel} />
          </div>
        ) : null}
      </div>
    </SettingRow>
  );
}

/** The rows of the Connection group: one per machine, or the line that says there is none. */
export function ConnectionPreferenceSettings({ machines, onChange }: ConnectionPreferenceSettingsProps) {
  if (machines.length === 0) return <SettingRow name="Connection" hint={NO_MACHINES_TO_CONNECT} />;
  return (
    <>
      {machines.map(machine => (
        <MachineConnectionRow key={machine.daemonId} machine={machine} onChange={onChange} />
      ))}
    </>
  );
}
