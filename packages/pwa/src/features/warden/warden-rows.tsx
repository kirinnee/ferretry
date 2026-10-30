/**
 * Investigations and Watching, in the same one-line style as Recent actions. Render-only.
 *
 * Wide: one line. On a phone: line 1 is the time and the name, line 2 is the chips (and whatever acts on
 * the row), so a row is two short lines and never a card. The 44px touch floor is the row, not each line.
 */

import {
  type SessionView,
  WARDEN_LEAVE_DURATIONS,
  type WardenLeaveDuration,
  type WardenStatusView,
} from '@ferretry/protocol';
import { useId, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { FerretLink, ferretName, ReportButton, SectionTitle, WardenChipBadge } from './warden-chips.tsx';
import {
  compactAgo,
  fullTime,
  investigationRows,
  type WardenReportTarget,
  type WardenRow,
} from './warden-overview-model.ts';

interface ListProps {
  readonly connection: DaemonConnection;
  readonly sessions: ReadonlyMap<string, SessionView>;
  readonly now: number;
  readonly onNavigate: ((to: string) => void) | undefined;
}

const TIME_CLASS = 'w-8 shrink-0 text-meta leading-base text-faint [font-variant-numeric:tabular-nums]';
const ROW_CLASS =
  'flex min-h-[44px] min-w-0 flex-wrap items-center gap-x-sm gap-y-0 px-cell-x py-xs sm:min-h-0 sm:flex-nowrap sm:py-row-y';
/** What Jev did first: a quiet line of its own under the row, at every width, lined up with the name. */
const JEV_LINE_CLASS =
  'order-last basis-full pl-[calc(2rem+theme(spacing.sm))] pb-xs text-meta leading-base text-faint sm:pb-0';

/** The second phone line: it stays one line, and dissolves into the row's own line from `sm` up. */
const SECOND_LINE_CLASS = 'order-last flex min-w-0 basis-full items-center gap-xs sm:contents';

export function InvestigationList({
  connection,
  status,
  sessions,
  now,
  onNavigate,
  onOpenReport,
}: ListProps & {
  readonly status: WardenStatusView;
  readonly onOpenReport: (target: WardenReportTarget) => void;
}) {
  const rows = investigationRows(status);
  return (
    <section aria-labelledby="warden-investigations" className="flex min-w-0 flex-col gap-sm">
      <SectionTitle id="warden-investigations" title="Investigations" count={rows.length} />
      {rows.length === 0 ? (
        <p className="m-0 text-meta text-muted">No investigations yet today.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-soft p-0">
          {rows.map(row => {
            const { reportPath } = row;
            return (
              <li
                key={row.key}
                className={`${ROW_CLASS} sm:flex-wrap`}
                data-warden-investigation={row.key}
                title={row.title}
              >
                <span className={TIME_CLASS} title={row.at === undefined ? undefined : fullTime(row.at)}>
                  {compactAgo(row.at, now)}
                </span>
                <span className="inline-flex min-w-0 flex-1 items-baseline gap-xs text-cell leading-base">
                  <span className={row.named ? 'mono shrink-0 text-fg-soft' : 'shrink-0 text-muted'}>
                    {row.investigator}
                  </span>
                  {row.sessionId !== undefined && (
                    <>
                      <span aria-hidden="true" className="text-faint">
                        →
                      </span>
                      <FerretLink
                        connection={connection}
                        sessionId={row.sessionId}
                        name={ferretName(sessions.get(row.sessionId), { sessionId: row.sessionId })}
                        onNavigate={onNavigate}
                      />
                    </>
                  )}
                </span>
                <span className={`${SECOND_LINE_CLASS} pt-xs sm:pt-0`}>
                  <WardenChipBadge chip={row.chip} />
                  {row.anomaly !== undefined && <WardenChipBadge chip={row.anomaly} />}
                  {row.cost !== undefined && (
                    <span className="shrink-0 text-meta text-muted [font-variant-numeric:tabular-nums]">
                      {row.cost}
                    </span>
                  )}
                  {reportPath !== undefined && (
                    <ReportButton
                      className="ml-auto sm:ml-0"
                      onClick={() =>
                        onOpenReport({
                          ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
                          reportPath,
                          ...(row.at === undefined ? {} : { at: row.at }),
                          ...(row.verdict === undefined ? {} : { verdict: row.verdict }),
                          jev: row.jev,
                        })
                      }
                    />
                  )}
                </span>
                <span className={JEV_LINE_CLASS} data-warden-jev>
                  {row.jev}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const LEAVE_LABELS: Readonly<Record<WardenLeaveDuration, string>> = {
  '1h': 'For 1 hour',
  '4h': 'For 4 hours',
  until_change: 'Until it changes',
};

/**
 * "Leave it longer": a small button that opens the three choices under the row. Buttons rather than a
 * `<select>` because a phone draws a field at 16px or more, which is too big for a row this small.
 */
function LeaveLonger({
  busy,
  open,
  controls,
  onToggle,
}: {
  readonly busy: boolean;
  readonly open: boolean;
  readonly controls: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      disabled={busy}
      className="ml-auto shrink-0 whitespace-nowrap rounded-control bg-transparent px-xs text-meta leading-base text-accent !min-h-7 !min-w-0 sm:!min-h-0"
      onClick={onToggle}
    >
      {busy ? 'Leaving it…' : 'Leave it longer…'}
    </button>
  );
}

function LeaveChoices({
  id,
  onPick,
}: {
  readonly id: string;
  readonly onPick: (duration: WardenLeaveDuration) => void;
}) {
  return (
    <fieldset id={id} className="m-0 flex min-w-0 flex-wrap items-center gap-xs border-0 px-cell-x pb-xs pt-0">
      <legend className="sr-only">Leave it longer</legend>
      {WARDEN_LEAVE_DURATIONS.map(duration => (
        <button
          key={duration}
          type="button"
          className="kt-btn kt-btn--sm !min-h-8 !min-w-0 sm:!min-h-0"
          onClick={() => onPick(duration)}
        >
          {LEAVE_LABELS[duration]}
        </button>
      ))}
    </fieldset>
  );
}

function WatchingItem({
  row,
  connection,
  sessions,
  now,
  onNavigate,
  onLeave,
  busy,
}: ListProps & {
  readonly row: WardenRow;
  readonly onLeave: ((sessionId: string, duration: WardenLeaveDuration) => void) | undefined;
  readonly busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const choicesId = useId();
  const canLeave = row.leave === true && onLeave !== undefined;
  return (
    <li className="flex min-w-0 flex-col" data-warden-row={row.key} title={row.reason}>
      <div className={ROW_CLASS}>
        <span className={TIME_CLASS} title={row.at === undefined ? undefined : fullTime(row.at)}>
          {compactAgo(row.at, now)}
        </span>
        <FerretLink
          connection={connection}
          sessionId={row.sessionId}
          name={ferretName(sessions.get(row.sessionId), row)}
          onNavigate={onNavigate}
          className="max-w-[12rem] flex-1"
        />
        <span className={`${SECOND_LINE_CLASS} flex-wrap pt-xs sm:pt-0`}>
          {row.chips.map(entry => (
            <WardenChipBadge key={entry.label} chip={entry} />
          ))}
          {canLeave && (
            <LeaveLonger busy={busy} open={open} controls={choicesId} onToggle={() => setOpen(current => !current)} />
          )}
        </span>
      </div>
      {canLeave && open && (
        <LeaveChoices
          id={choicesId}
          onPick={duration => {
            setOpen(false);
            onLeave(row.sessionId, duration);
          }}
        />
      )}
    </li>
  );
}

export function WatchingList({
  connection,
  rows,
  sessions,
  now,
  onNavigate,
  onLeave,
  leaving,
}: ListProps & {
  readonly rows: readonly WardenRow[];
  readonly onLeave: ((sessionId: string, duration: WardenLeaveDuration) => void) | undefined;
  readonly leaving: ReadonlySet<string>;
}) {
  return (
    <section aria-labelledby="warden-watching" className="flex min-w-0 flex-col gap-sm">
      <SectionTitle id="warden-watching" title="Watching" count={rows.length} />
      {rows.length === 0 ? (
        <p className="m-0 text-meta text-muted">Nothing is being watched right now.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-soft p-0">
          {rows.map(row => (
            <WatchingItem
              key={row.key}
              row={row}
              connection={connection}
              sessions={sessions}
              now={now}
              onNavigate={onNavigate}
              onLeave={onLeave}
              busy={leaving.has(row.sessionId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
