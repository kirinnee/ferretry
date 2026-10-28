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
import { Toggle } from './notification-settings.tsx';

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
    <li
      className="flex flex-col gap-1 rounded-control border border-border bg-surface-2 p-2"
      data-machine-notification={row.daemonId}
      data-machine-status={row.status}
    >
      <Toggle
        checked={on}
        disabled={disabled}
        onChange={next => (next ? onEnable(row.daemonId) : onDisable(row.daemonId))}
        label={row.label}
        description="Notify this browser from this machine, even when the app is closed."
      />
      <p
        className={cn('m-0 px-1 text-meta leading-base', STATUS_TONE[row.status])}
        data-machine-status-text=""
        role="status"
      >
        {busy ? 'Working…' : row.statusText}
      </p>
      {failure === undefined ? null : (
        <p className="m-0 px-1 text-meta leading-base text-warn" role="alert">
          {failure}
        </p>
      )}
      <Toggle
        checked={row.shown}
        onChange={next => onToggleShown(row.daemonId, next)}
        label="Show its notifications"
        description="Off mutes this machine on this browser alone; every other pairing is unaffected."
      />
    </li>
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
    <section className="flex flex-col gap-2" aria-label="Notifications per machine">
      <div className="flex items-center justify-between gap-3">
        <span className="text-meta font-semibold text-muted">Machines</span>
        <Button variant="primary" data-notification-turn-on-all="" disabled={!turnOnable} onClick={onTurnOnAll}>
          Turn on for all machines
        </Button>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
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
      </ul>
    </section>
  );
}

export interface NotificationsOffBannerProps {
  readonly rows: readonly MachineNotificationRow[];
  readonly canEnrol: boolean;
  readonly busy: ReadonlySet<string>;
  readonly onEnable: (daemonId: string) => void;
}

/** One line per machine that has no enrolled device anywhere, each with a one-tap enable. Nothing when none. */
export function NotificationsOffBanner({ rows, canEnrol, busy, onEnable }: NotificationsOffBannerProps) {
  const off = machinesOffEverywhere(rows);
  if (off.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Notifications are off" data-notifications-off="">
      {off.map(row => (
        <li
          key={row.daemonId}
          className="flex flex-wrap items-center gap-2 rounded-control border border-warn bg-warn-bg px-control-x py-2"
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
    </ul>
  );
}
