/**
 * The daemon filter of the Warden page: All, then each paired daemon, the choice kept on this device.
 *
 * A `SelectBox`, in the same look as the Inbox's machine filter (`fy-attn-inbox__machine`), so a phone gets
 * a centred, searchable dialog and a keyboard gets the combobox keys.
 */

import { SelectBox } from '@ferretry/app/ui';
import { useId } from 'react';
import { INSIGHTS_COLUMN_CLASS } from '../../lib/layout.ts';
import type { DaemonId } from '../../lib/machine.ts';
import type { WardenMachine } from './warden-daemon-scope.ts';

export function WardenDaemonFilter({
  machines,
  selected,
  onChoose,
}: {
  readonly machines: readonly WardenMachine[];
  readonly selected: DaemonId | null;
  readonly onChoose: (daemonId: DaemonId | null) => void;
}) {
  const id = useId();
  return (
    <div className={`${INSIGHTS_COLUMN_CLASS} flex min-w-0 items-center gap-sm pt-3 sm:pt-4`} data-warden-filter="">
      <div className="flex min-w-0 items-center gap-sm text-meta text-muted">
        <label htmlFor={id}>Daemon</label>
        <SelectBox
          id={id}
          className="fy-attn-inbox__machine !min-h-[44px] !min-w-[10rem] sm:!min-h-8"
          label="Daemon"
          onChange={next => onChoose(next === '' ? null : (next as DaemonId))}
          options={[
            { value: '', label: 'All daemons' },
            ...machines.map(machine => ({ value: machine.connection.daemonId, label: machine.name })),
          ]}
          value={selected ?? ''}
        />
      </div>
    </div>
  );
}
