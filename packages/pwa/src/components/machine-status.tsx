/**
 * ONE MACHINE'S OUTAGE, SAID IN THAT MACHINE'S OWN PLACE.
 *
 * - `MachineStatusChip`: the compact line under a machine's heading in the Sessions list — "Asleep ·
 *   retrying · as of 23:05" with Retry now and Details. It sits in the flow of that machine's section,
 *   so it never covers another machine's rows or the page's controls.
 * - `MachineStatusRow`: the same fact on that machine's own page when it is the only one listed — the
 *   sentence for people ("Liftoff MBP isn't reachable right now") instead of the transport's.
 * - `MachineOutageSheet`: Details. The only place the raw text — addresses, close codes, which carrier
 *   said what — reaches the screen.
 *
 * No store: the caller hands in the outage (`lib/machine-outage.ts`) and what Retry now does.
 */

import { CloudOff, PowerOff, RefreshCw, TimerOff, TriangleAlert, WifiOff } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { outageDuration } from '../features/connection/connection-copy.ts';
import { cn } from '../lib/class-names.ts';
import type { MachineOutage, OutageReason } from '../lib/machine-outage.ts';
import { type ClockEnvironment, clockOfInstant } from '../lib/message-clock.ts';
import { BottomSheet } from '../shell/bottom-sheet.tsx';

const REASON_ICON: Readonly<Record<OutageReason, ReactNode>> = {
  'daemon-unreachable': <PowerOff aria-hidden="true" size={13} />,
  'device-offline': <WifiOff aria-hidden="true" size={13} />,
  'relay-unreachable': <CloudOff aria-hidden="true" size={13} />,
  unknown: <CloudOff aria-hidden="true" size={13} />,
  'not-answering': <TimerOff aria-hidden="true" size={13} />,
  'refresh-failed': <TriangleAlert aria-hidden="true" size={13} />,
};

/** "as of 23:05" on the reader's own clock, or `null` when nothing was ever read from the machine. */
const asOfLabel = (readAt: number | null, clock: ClockEnvironment = {}): string | null => {
  if (readAt === null) return null;
  const time = clockOfInstant(readAt, clock);
  return time === undefined ? null : `as of ${time.short}`;
};

const MACHINE_STATUS_COPY = {
  retryNow: 'Retry now',
  details: 'Details',
  title: (name: string): string => `${name} connection`,
  close: 'Close machine details',
  technical: 'What each request said',
  lostFor: (duration: string): string => `Lost ${duration} ago`,
  attempts: (attempt: number): string => (attempt === 1 ? '1 automatic attempt' : `${attempt} automatic attempts`),
  kept: 'Its sessions stay on screen as they last were, and nothing on your other machines waits for it.',
} as const;

interface MachineStatusProps {
  readonly outage: MachineOutage;
  readonly now: number;
  readonly onRetry?: () => void;
  /** Pinned only by tests and captures; production reads the device's clock. */
  readonly clock?: ClockEnvironment;
  readonly className?: string;
}

/** Details for one machine: the plain sentence first, then how long and how often, then the raw text. */
function MachineOutageSheet({
  id,
  open,
  onClose,
  outage,
  now,
  onRetry,
  clock,
}: Omit<MachineStatusProps, 'className'> & {
  readonly id: string;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const titleId = `${id}-title`;
  const asOf = asOfLabel(outage.readAt, clock);
  return (
    <BottomSheet
      id={id}
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      closeLabel={MACHINE_STATUS_COPY.close}
      panelClassName="px-panel pb-panel"
    >
      <div className="flex min-w-0 flex-col gap-3 pb-md text-ui leading-base text-fg" data-machine-outage-sheet="">
        <h2 id={titleId} className="m-0 text-title font-semibold">
          {MACHINE_STATUS_COPY.title(outage.name)}
        </h2>
        <p className="m-0 font-semibold">{outage.headline}</p>
        <p className="m-0">{outage.advice}</p>
        <p className="m-0 text-meta text-muted" data-machine-outage-meta="">
          {[
            outage.since === null ? null : MACHINE_STATUS_COPY.lostFor(outageDuration(outage.since, now)),
            outage.attempt === null || outage.attempt === 0 ? null : MACHINE_STATUS_COPY.attempts(outage.attempt),
            asOf,
          ]
            .filter(part => part !== null)
            .join(' · ')}
        </p>
        <p className="m-0 text-meta text-muted">{MACHINE_STATUS_COPY.kept}</p>
        {onRetry === undefined ? null : (
          <div>
            <button type="button" className="kt-btn min-h-control" onClick={onRetry} data-machine-retry="">
              <RefreshCw size={14} aria-hidden="true" />
              {MACHINE_STATUS_COPY.retryNow}
            </button>
          </div>
        )}
        {outage.technical.length === 0 ? null : (
          <section aria-labelledby={`${id}-technical`} className="flex min-w-0 flex-col gap-1">
            <h3 id={`${id}-technical`} className="m-0 text-meta font-semibold text-muted">
              {MACHINE_STATUS_COPY.technical}
            </h3>
            <dl className="m-0 flex min-w-0 flex-col gap-2">
              {outage.technical.map(line => (
                <div key={line.label} className="min-w-0" data-machine-outage-line={line.label}>
                  <dt className="font-semibold">{line.label}</dt>
                  <dd className="m-0 break-words font-mono text-meta text-muted">{line.detail}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </BottomSheet>
  );
}

/** Retry now and Details, shared by the chip and the row. */
function OutageActions({
  outage,
  now,
  onRetry,
  clock,
}: Pick<MachineStatusProps, 'outage' | 'now' | 'onRetry' | 'clock'>) {
  const sheetId = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      {onRetry === undefined ? null : (
        <button
          type="button"
          className="kt-btn kt-btn--sm"
          onClick={onRetry}
          data-machine-retry=""
          aria-label={`${MACHINE_STATUS_COPY.retryNow}: ${outage.name}`}
        >
          <RefreshCw size={12} aria-hidden="true" />
          {MACHINE_STATUS_COPY.retryNow}
        </button>
      )}
      <button
        type="button"
        className="kt-btn kt-btn--sm"
        data-variant="ghost"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={sheetId}
        aria-label={`${MACHINE_STATUS_COPY.details}: ${outage.name}`}
        onClick={() => setOpen(true)}
        data-machine-details=""
      >
        {MACHINE_STATUS_COPY.details}
      </button>
      <MachineOutageSheet
        id={sheetId}
        open={open}
        onClose={() => setOpen(false)}
        outage={outage}
        now={now}
        {...(onRetry === undefined ? {} : { onRetry })}
        {...(clock === undefined ? {} : { clock })}
      />
    </>
  );
}

/** The compact status line under a machine's heading: icon, "Asleep · retrying · as of 23:05", actions. */
export function MachineStatusChip({ outage, now, onRetry, clock, className }: MachineStatusProps) {
  const asOf = asOfLabel(outage.readAt, clock);
  return (
    <div
      className={cn('fy-machine-status', className)}
      data-machine-status={outage.reason}
      role="status"
      aria-label={`${outage.headline}${asOf === null ? '' : `, ${asOf}`}`}
    >
      <span className="fy-machine-status__chip">
        {REASON_ICON[outage.reason]}
        <span className="truncate">{outage.chip}</span>
      </span>
      {asOf === null ? null : <span className="fy-machine-status__asof mono">{asOf}</span>}
      <span className="fy-machine-status__actions">
        <OutageActions outage={outage} now={now} {...(onRetry === undefined ? {} : { onRetry })} clock={clock} />
      </span>
    </div>
  );
}

/** One machine's own page, when it is the machine that is down: the plain sentence, in place, not red. */
export function MachineStatusRow({ outage, now, onRetry, clock, className }: MachineStatusProps) {
  const asOf = asOfLabel(outage.readAt, clock);
  return (
    <div
      className={cn(
        'mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-warn-border bg-warn-bg px-panel py-row-y text-row',
        className,
      )}
      data-machine-status-row={outage.reason}
      role="status"
    >
      <div className="flex min-w-0 flex-[1_1_14rem] items-start gap-2 text-warn">
        <span className="mt-1 shrink-0">{REASON_ICON[outage.reason]}</span>
        <div className="min-w-0">
          <p className="m-0 font-semibold">{outage.headline}</p>
          <p className="m-0 text-meta text-muted">
            {outage.chip}
            {asOf === null ? '' : ` · showing sessions ${asOf}`}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <OutageActions outage={outage} now={now} {...(onRetry === undefined ? {} : { onRetry })} clock={clock} />
      </div>
    </div>
  );
}
