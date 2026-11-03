/**
 * THE ONE PER-MACHINE NOTIFICATIONS LIST, and the banner that says a machine reaches nobody.
 *
 * Every paired machine, the active one included, is one row: its own enrol switch (this browser with THAT
 * daemon), its status, and the local mute folded in. Render-only; `use-machine-notifications.ts` owns the
 * reads and the enrolment, and `machine-notifications.ts` the row model.
 */
import { BellOff } from 'lucide-react';
import { cn } from '../../lib/class-names.ts';
import {
  type MachineNotificationRow,
  machinesOffEverywhere,
  offEverywhereSentence,
  turnOnAllTargets,
} from '../../lib/machine-notifications.ts';
import { Button } from '../../shell/primitives.tsx';
import { SettingRow, SettingSwitch } from './setting-row.tsx';

export interface MachineNotificationListProps {
  readonly rows: readonly MachineNotificationRow[];
  /** `denied` / `unsupported` mean no switch can turn a machine on. */
  readonly canEnrol: boolean;
  readonly busy: ReadonlySet<string>;
  readonly failures: Readonly<Record<string, string>>;
  readonly onEnable: (daemonId: string) => void;
  readonly onDisable: (daemonId: string) => void;
  readonly onTurnOnAll: () => void;
  readonly onToggleShown: (daemonId: string, shown: boolean) => void;
}

const STATUS_TONE: Readonly<Record<MachineNotificationRow['status'], string>> = {
  checking: 'text-muted',
  on: 'text-ok',
  off: 'text-muted',
  offline: 'text-warn',
  'needs-update': 'text-warn',
};

function MachineRow({
  row,
  canEnrol,
  busy,
  failure,
  onEnable,
  onDisable,
  onToggleShown,
}: { readonly row: MachineNotificationRow; readonly busy: boolean; readonly failure: string | undefined } & Pick<
  MachineNotificationListProps,
  'canEnrol' | 'onEnable' | 'onDisable' | 'onToggleShown'
>) {
  const on = row.status === 'on';
  // A machine that is on can always be turned off; one that is off needs permission and an answering machine.
  const disabled = busy || (on ? false : row.status !== 'off' || !canEnrol);
  return (
    <SettingRow
      name={row.label}
      dataAttributes={{ 'data-machine-notification': row.daemonId, 'data-machine-status': row.status }}
      hint={
        <span className={cn(STATUS_TONE[row.status])} data-machine-status-text="" role="status">
          {busy ? 'Working…' : row.statusText}
        </span>
      }
      control={() => (
        <>
          <button
            type="button"
            className="min-h-[44px] shrink-0 px-2 text-meta text-muted underline"
            data-machine-mute=""
            aria-pressed={!row.shown}
            onClick={() => onToggleShown(row.daemonId, !row.shown)}
          >
            {row.shown ? 'Mute' : 'Unmute'}
          </button>
          <SettingSwitch
            checked={on}
            labelledBy=""
            ariaLabel={`Notifications from ${row.label}`}
            disabled={disabled}
            onChange={() => (on ? onDisable(row.daemonId) : onEnable(row.daemonId))}
          />
        </>
      )}
    >
      {failure === undefined ? null : (
        <p className="m-0 px-panel pb-3 text-meta leading-base text-warn" role="alert">
          {failure}
        </p>
      )}
    </SettingRow>
  );
}

export function MachineNotificationList({
  rows,
  canEnrol,
  busy,
  failures,
  onEnable,
  onDisable,
  onTurnOnAll,
  onToggleShown,
}: MachineNotificationListProps) {
  if (rows.length === 0) return null;
  const turnOnable = turnOnAllTargets(rows).length > 0 && canEnrol;
  return (
    <>
      <SettingRow
        name="Machines"
        hint="Turn on, or mute, one machine at a time"
        explanation="Turn a machine on to be notified from it on this browser, even when the app is closed. Mute silences one here only."
        wide
        control={() => (
          <Button variant="primary" data-notification-turn-on-all="" disabled={!turnOnable} onClick={onTurnOnAll}>
            Turn on for all machines
          </Button>
        )}
      />
      {rows.map(row => (
        <MachineRow
          key={row.daemonId}
          row={row}
          canEnrol={canEnrol}
          busy={busy.has(row.daemonId)}
          failure={failures[row.daemonId]}
          onEnable={onEnable}
          onDisable={onDisable}
          onToggleShown={onToggleShown}
        />
      ))}
    </>
  );
}

export interface NotificationsOffBannerProps {
  readonly rows: readonly MachineNotificationRow[];
  readonly canEnrol: boolean;
  readonly busy: ReadonlySet<string>;
  readonly onEnable: (daemonId: string) => void;
}

/** One row per machine that has no enrolled device anywhere, each with a one-tap enable. Nothing when none. */
export function NotificationsOffBanner({ rows, canEnrol, busy, onEnable }: NotificationsOffBannerProps) {
  const off = machinesOffEverywhere(rows);
  if (off.length === 0) return null;
  return (
    <>
      {off.map(row => (
        <li
          key={row.daemonId}
          className="flex flex-wrap items-center gap-2 bg-warn-bg px-panel py-2"
          data-notifications-off=""
          data-notifications-off-machine={row.daemonId}
          role="status"
        >
          <BellOff aria-hidden="true" size={16} className="shrink-0 text-warn" />
          <span className="min-w-0 flex-1 text-ui leading-base text-fg">{offEverywhereSentence(row.label)}</span>
          <Button
            variant="primary"
            data-notifications-off-enable=""
            disabled={busy.has(row.daemonId) || !canEnrol}
            onClick={() => onEnable(row.daemonId)}
          >
            Turn on
          </Button>
        </li>
      ))}
    </>
  );
}
