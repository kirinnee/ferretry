/**
 * The daemon filter of the Warden page: All, then each paired daemon, the choice kept on this device.
 *
 * The same native select as the Inbox's machine filter, in the same look (`fy-attn-inbox__machine`), so
 * a phone gets its own picker and a keyboard gets the usual keys.
 */

import type { DaemonId } from '../../lib/daemon-connection.ts';
import { INSIGHTS_COLUMN_CLASS } from '../../shell/insights-frame.tsx';
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
  return (
    <div className={`${INSIGHTS_COLUMN_CLASS} flex min-w-0 items-center gap-sm pt-3 sm:pt-4`} data-warden-filter="">
      <label className="flex min-w-0 items-center gap-sm text-meta text-muted">
        <span>Daemon</span>
        <select
          aria-label="Daemon"
          className="fy-attn-inbox__machine min-h-[44px] sm:min-h-8"
          onChange={event => onChoose(event.target.value === '' ? null : (event.target.value as DaemonId))}
          value={selected ?? ''}
        >
          <option value="">All daemons</option>
          {machines.map(machine => (
            <option key={machine.connection.daemonId} value={machine.connection.daemonId}>
              {machine.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
