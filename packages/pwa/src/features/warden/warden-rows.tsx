/**
 * Investigations and Watching, in the same one-line style as Recent actions. Render-only.
 */

import {
  type SessionView,
  WARDEN_LEAVE_DURATIONS,
  type WardenLeaveDuration,
  type WardenStatusView,
} from '@ferretry/protocol';

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

const TIME_CLASS = 'w-8 shrink-0 text-meta text-faint [font-variant-numeric:tabular-nums]';

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
                className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs px-cell-x py-row-y sm:flex-nowrap"
                data-warden-investigation={row.key}
                title={row.title}
              >
                <span className={TIME_CLASS} title={row.at === undefined ? undefined : fullTime(row.at)}>
                  {compactAgo(row.at, now)}
                </span>
                <span className="inline-flex min-w-[12rem] flex-1 items-baseline gap-xs text-cell sm:min-w-0">
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
                <WardenChipBadge chip={row.chip} />
                {row.anomaly !== undefined && <WardenChipBadge chip={row.anomaly} />}
                {row.cost !== undefined && (
                  <span className="shrink-0 text-meta text-muted [font-variant-numeric:tabular-nums]">{row.cost}</span>
                )}
                {reportPath !== undefined && row.sessionId !== undefined && (
                  <ReportButton
                    onClick={() =>
                      onOpenReport({
                        sessionId: row.sessionId!,
                        reportPath,
                        ...(row.at === undefined ? {} : { at: row.at }),
                        ...(row.verdict === undefined ? {} : { verdict: row.verdict }),
                      })
                    }
                  />
                )}
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

/** "Leave it longer": a native select, so a keyboard reaches every choice and picking one sends it. */
function LeaveLonger({
  sessionId,
  busy,
  onLeave,
}: {
  readonly sessionId: string;
  readonly busy: boolean;
  readonly onLeave: (sessionId: string, duration: WardenLeaveDuration) => void;
}) {
  return (
    <select
      aria-label="Leave it longer"
      className="kt-input !min-h-[44px] !w-auto max-w-[10rem] shrink-0 !py-0 !px-xs sm:!text-meta sm:!min-h-0"
      value=""
      disabled={busy}
      onChange={event => {
        const choice = WARDEN_LEAVE_DURATIONS.find(duration => duration === event.target.value);
        if (choice !== undefined) onLeave(sessionId, choice);
      }}
    >
      <option value="">{busy ? 'Leaving it…' : 'Leave it longer…'}</option>
      {WARDEN_LEAVE_DURATIONS.map(duration => (
        <option key={duration} value={duration}>
          {LEAVE_LABELS[duration]}
        </option>
      ))}
    </select>
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
            <li
              key={row.key}
              className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs px-cell-x py-row-y sm:flex-nowrap"
              data-warden-row={row.key}
              title={row.reason}
            >
              <span className={TIME_CLASS} title={row.at === undefined ? undefined : fullTime(row.at)}>
                {compactAgo(row.at, now)}
              </span>
              <FerretLink
                connection={connection}
                sessionId={row.sessionId}
                name={ferretName(sessions.get(row.sessionId), row)}
                onNavigate={onNavigate}
                className="max-w-[12rem] sm:flex-1"
              />
              <span className="flex min-w-0 flex-wrap items-center gap-xs">
                {row.chips.map(entry => (
                  <WardenChipBadge key={entry.label} chip={entry} />
                ))}
              </span>
              {row.leave === true && onLeave !== undefined && (
                <LeaveLonger sessionId={row.sessionId} busy={leaving.has(row.sessionId)} onLeave={onLeave} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
