/**
 * THE ONE PER-MACHINE NOTIFICATIONS LIST, and the banner that says a machine reaches nobody.
 *
 * This machine is one row: its own enrol switch (this browser with THAT daemon) and its status. Render-only;
 * `use-machine-notification.ts` owns the read and the enrolment, and `machine-notifications.ts` the row model.
 *
 * NO MUTE HERE. Which machines this browser shows or silences is Agenda's notification filter, a different store.
 */
import { BellOff } from 'lucide-react';
import { Button, cn } from '../../shell-grants.ts';
import {
  type MachineNotificationRow,
  machinesOffEverywhere,
  offEverywhereSentence,
} from '../../lib/machine-notifications.ts';

export interface MachineNotificationListProps {
  readonly rows: readonly MachineNotificationRow[];
  /** `denied` / `unsupported` mean no switch can turn a machine on. */
  readonly canEnrol: boolean;
  readonly busy: ReadonlySet<string>;
  readonly failures: Readonly<Record<string, string>>;
  readonly onEnable: (daemonId: string) => void;
  readonly onDisable: (daemonId: string) => void;
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
}: { readonly row: MachineNotificationRow; readonly busy: boolean; readonly failure: string | undefined } & Pick<
  MachineNotificationListProps,
  'canEnrol' | 'onEnable' | 'onDisable'
>) {
  const on = row.status === 'on';
  // A machine that is on can always be turned off; one that is off needs permission and an answering machine.
  const disabled = busy || (on ? false : row.status !== 'off' || !canEnrol);
  return (
    <li
      className="flex flex-col gap-1 rounded-control border border-border bg-surface-2 px-control-x py-2"
      data-machine-notification={row.daemonId}
      data-machine-status={row.status}
    >
      <div className="flex min-h-[36px] items-center gap-2">
        <span className="min-w-0 truncate text-ui font-semibold text-fg">{row.label}</span>
        <span
          className={cn('shrink-0 text-meta leading-base', STATUS_TONE[row.status])}
          data-machine-status-text=""
          role="status"
        >
          {busy ? 'Working…' : row.statusText}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`Notifications from ${row.label}`}
          disabled={disabled}
          onClick={() => (on ? onDisable(row.daemonId) : onEnable(row.daemonId))}
          className={cn(
            'ml-auto flex shrink-0 items-center justify-center',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'relative block h-6 w-11 shrink-0 rounded-full border transition-colors',
              on ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
            )}
          >
            <span
              className={cn(
                'absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-fg transition-transform',
                on ? 'translate-x-[22px]' : 'translate-x-[2px]',
              )}
            />
          </span>
        </button>
      </div>
      {failure === undefined ? null : (
        <p className="m-0 text-meta leading-base text-warn" role="alert">
          {failure}
        </p>
      )}
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
}: MachineNotificationListProps) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Notifications per machine">
      <span className="text-meta font-semibold text-muted">Machine</span>
      <p className="m-0 text-meta leading-base text-muted">
        Turn a machine on to be notified from it on this browser, even when the app is closed.
      </p>
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
