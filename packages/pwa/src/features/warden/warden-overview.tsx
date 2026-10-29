/**
 * The Warden page body: one status sentence, the savings line, then sessions grouped by what they need
 * from the owner, two histories, and a one-line account summary.
 *
 * RENDER-ONLY. The daemon-bound host (`warden-overview-surface.tsx`) owns the reads, the sweep and the
 * investigate requests; this draws what it is handed, so a test or a screenshot can drive every state.
 *
 * Every row is a session: a status mark, its name, its folder, a reason that WRAPS (it is the row's whole
 * content, so it is never cut), state chips, and a time on the right. The row itself opens the session;
 * its buttons sit beside the link, never inside it.
 */

import {
  type SessionView,
  WARDEN_LEAVE_DURATIONS,
  type WardenAttentionView,
  type WardenLeaveDuration,
  type WardenStatusView,
} from '@ferretry/protocol';
import { AlertTriangle, FileText, LoaderCircle, RefreshCw, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';

import { sessionDisplayName } from '../../components/session-top-bar.tsx';
import type { WardenReadState } from '../../hooks/use-warden-poll.ts';
import { readView } from '../../hooks/use-warden-poll.ts';
import { displayCallsign, shortSessionId } from '../../lib/callsign.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSessionPath } from '../../lib/pages/routes.ts';
import { relativeTime } from '../../lib/session-screens.ts';
import { INSIGHTS_COLUMN_CLASS } from '../../shell/insights-frame.tsx';
import { Badge } from '../../shell/primitives.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { StatusMark } from '../../shell/status-mark.tsx';
import {
  accountChip,
  actionRows,
  investigationRows,
  needsYouEmpty,
  needsYouRows,
  type WardenRow,
  wardenHowItWorks,
  wardenSavingsLine,
  wardenStatusLine,
  watchingRows,
} from './warden-overview-model.ts';
import type { WardenChip } from './warden-vocabulary.ts';

/** A short-lived answer to something the owner just did: a sweep, an investigate request. */
export interface WardenNotice {
  readonly tone: 'ok' | 'err';
  readonly text: string;
}

export interface WardenOverviewProps {
  readonly connection: DaemonConnection;
  readonly status: WardenReadState<WardenStatusView>;
  readonly attention: WardenReadState<WardenAttentionView>;
  /** This daemon's sessions, for names and status marks; `null` while not read yet. */
  readonly sessions?: readonly SessionView[] | null;
  readonly now: number;
  readonly sweeping?: boolean;
  readonly notice?: WardenNotice | null;
  /** Sessions whose investigate request is in flight. */
  readonly investigating?: ReadonlySet<string>;
  /** Settings › Warden for this daemon. */
  readonly settingsHref: string;
  readonly onNavigate?: (to: string) => void;
  readonly onSweep: () => void;
  readonly onInvestigate: (sessionId: string) => void;
  /** Leave a flagged or cleared ferret alone for longer. Absent: the control is not offered. */
  readonly onLeave?: (sessionId: string, duration: WardenLeaveDuration) => void;
  /** Sessions whose leave request is in flight. */
  readonly leaving?: ReadonlySet<string>;
  readonly onOpenReport: (row: WardenRow & { readonly reportPath: string }) => void;
}

/** The project folder's name: the last part of the session's working directory. */
const folder = (session: SessionView): string => session.config.cwd.split('/').filter(Boolean).at(-1) ?? '';

export function WardenChipBadge({ chip }: { readonly chip: WardenChip }) {
  return (
    <Badge tone={chip.tone} className="shrink-0 whitespace-nowrap">
      {chip.busy === true && (
        <LoaderCircle size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      )}
      {chip.label}
    </Badge>
  );
}

export function WardenOverview({
  connection,
  status,
  attention,
  sessions = null,
  now,
  sweeping = false,
  notice = null,
  investigating = new Set<string>(),
  settingsHref,
  onNavigate,
  onSweep,
  onInvestigate,
  onLeave,
  leaving = new Set<string>(),
  onOpenReport,
}: WardenOverviewProps) {
  const statusView = readView(status);
  const attentionView = readView(attention);
  const needs = attentionView === undefined ? [] : needsYouRows(attentionView);
  const needIds = new Set(needs.map(row => row.sessionId));
  const watching = statusView === undefined ? [] : watchingRows(statusView, attentionView, needIds, now);
  const bySession = new Map((sessions ?? []).map(session => [session.config.id, session]));
  const row = (entry: WardenRow, actions?: ReactNode) => (
    <SessionRow
      key={entry.key}
      connection={connection}
      row={entry}
      session={bySession.get(entry.sessionId)}
      now={now}
      onNavigate={onNavigate}
      actions={actions}
    />
  );
  const leaveControl = (entry: WardenRow) =>
    entry.leave !== true || onLeave === undefined ? null : (
      <LeaveLonger sessionId={entry.sessionId} busy={leaving.has(entry.sessionId)} onLeave={onLeave} />
    );
  const reportButton = ({ reportPath, ...entry }: WardenRow) =>
    reportPath === undefined ? null : (
      <button
        type="button"
        className="kt-btn kt-btn--sm min-h-[44px]"
        onClick={() => onOpenReport({ ...entry, reportPath })}
      >
        <FileText size={14} aria-hidden="true" />
        Report
      </button>
    );

  return (
    <div
      className={`${INSIGHTS_COLUMN_CLASS} flex min-w-0 flex-col gap-4 pb-8 pt-3 sm:pt-4`}
      data-daemon={connection.daemonId}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-md gap-y-sm">
        <h2 className="m-0 flex items-center gap-sm text-title font-semibold leading-tight text-fg">
          <ShieldCheck size={18} className="text-accent" aria-hidden="true" />
          Warden
        </h2>
        <div className="flex flex-wrap gap-sm">
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            data-variant="primary"
            disabled={sweeping || statusView?.config.enabled === false}
            onClick={onSweep}
          >
            {sweeping ? (
              <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
            {sweeping ? 'Sweeping…' : 'Sweep now'}
          </button>
          <RouteLink
            to={settingsHref}
            {...(onNavigate === undefined ? {} : { onNavigate })}
            className="kt-btn min-h-[44px] no-underline"
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            Settings
          </RouteLink>
        </div>
      </header>

      <StatusSummary status={status} needs={needs.length} watching={watching.length} now={now} />
      {notice !== null && (
        <p
          role={notice.tone === 'err' ? 'alert' : 'status'}
          className={cn('m-0 text-meta leading-base', notice.tone === 'err' ? 'text-err' : 'text-muted')}
        >
          {notice.text}
        </p>
      )}

      <Group title="Needs you" count={needs.length}>
        <NeedsYouBody attention={attention} empty={needs.length === 0}>
          {needs.map(entry =>
            row(
              entry,
              <>
                {entry.investigate === true && (
                  <button
                    type="button"
                    className="kt-btn kt-btn--sm min-h-[44px]"
                    disabled={investigating.has(entry.sessionId)}
                    onClick={() => onInvestigate(entry.sessionId)}
                  >
                    {investigating.has(entry.sessionId) ? (
                      <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    ) : (
                      <ShieldCheck size={14} aria-hidden="true" />
                    )}
                    Investigate
                  </button>
                )}
                {leaveControl(entry)}
                {reportButton(entry)}
              </>,
            ),
          )}
        </NeedsYouBody>
      </Group>

      {statusView !== undefined && (
        <>
          <Group title="Watching" count={watching.length} empty="Nothing is being watched right now.">
            {watching.map(entry => row(entry, leaveControl(entry)))}
          </Group>
          <Group title="Investigations" count={statusView.investigations.length} empty="No investigations yet today.">
            {investigationRows(statusView).map(entry => row(entry, reportButton(entry)))}
          </Group>
          <Group
            title="Recent actions & blessings"
            count={statusView.actions.length}
            empty="The Warden has not acted or blessed anything yet."
          >
            {actionRows(statusView).map(entry => row(entry, reportButton(entry)))}
          </Group>
          <AccountSummary status={statusView} settingsHref={settingsHref} onNavigate={onNavigate} />
        </>
      )}
    </div>
  );
}

function StatusSummary({
  status,
  needs,
  watching,
  now,
}: {
  readonly status: WardenReadState<WardenStatusView>;
  readonly needs: number;
  readonly watching: number;
  readonly now: number;
}) {
  if (status.status === 'loading')
    return (
      <p role="status" className="m-0 flex items-center gap-xs text-ui text-muted">
        <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Reading the Warden’s status…
      </p>
    );
  if (status.status === 'error')
    return (
      <div role="alert" className="rounded-control border border-err-border bg-err-bg px-cell-x py-row-y">
        <p className="m-0 text-row font-semibold text-err">Warden status unavailable</p>
        <p className="m-0 mt-xs text-meta leading-base text-muted">
          {status.reason}. This is unknown, not an all-clear.
        </p>
      </div>
    );
  const view = status.view;
  const line = wardenStatusLine(view, now);
  const savings = wardenSavingsLine(view);
  return (
    <div className="flex min-w-0 flex-col gap-sm">
      <p role="status" className="m-0 flex flex-wrap items-center gap-x-sm gap-y-xs text-ui leading-base text-fg">
        <span>
          <b className="font-semibold">{line.lead}</b> <span className="text-muted">{line.parts.join(' · ')}</span>
        </span>
        {needs > 0 && <Badge tone="warn">{needs} need you</Badge>}
        {watching > 0 && <Badge tone="pend">{watching} watching</Badge>}
        {line.warning !== undefined && (
          // Wraps rather than clipping: the warning is a sentence, and at 390px its end (when a paced layer
          // is back, what becomes of a flag) is the part that matters.
          <Badge tone="warn" data-warden-warning className="max-w-full !whitespace-normal [overflow-wrap:anywhere]">
            <AlertTriangle size={11} aria-hidden="true" className="shrink-0" />
            {line.warning}
          </Badge>
        )}
      </p>
      {status.status === 'stale' && (
        <p role="alert" className="m-0 text-meta leading-base text-warn">
          Could not refresh the status ({status.reason}); this is the last good read.
        </p>
      )}
      {savings !== undefined && (
        <p className="m-0 rounded-control border border-border-strong bg-surface-2 px-cell-x py-1.5 text-meta leading-base text-fg-soft">
          {savings}
        </p>
      )}
      <p className="m-0 text-meta leading-base text-faint">{wardenHowItWorks(view.config.layers)}</p>
    </div>
  );
}

function NeedsYouBody({
  attention,
  empty,
  children,
}: {
  readonly attention: WardenReadState<WardenAttentionView>;
  readonly empty: boolean;
  readonly children: ReactNode;
}) {
  if (attention.status === 'loading')
    return <p className="m-0 px-cell-x py-row-y text-meta text-muted">Checking who needs you…</p>;
  if (attention.status === 'error')
    return (
      <div role="alert" className="border-l-heavy border-err px-cell-x py-row-y">
        <p className="m-0 text-row font-semibold text-err">Can’t say who needs you</p>
        <p className="m-0 mt-xs text-meta leading-base text-muted">
          {attention.reason}. Treat this as unknown, not as all clear.
        </p>
      </div>
    );
  const view = attention.view;
  const stale = attention.status === 'stale';
  const brokenBoards = view.boardsWithParseErrors.length;
  return (
    <>
      {stale && (
        <p role="alert" className="m-0 px-cell-x py-1.5 text-meta leading-base text-warn">
          Can’t refresh who needs you ({attention.reason}). The list below is from the last good check, and someone may
          need you since.
        </p>
      )}
      {view.wardenDegraded !== undefined && (
        <p role="alert" className="m-0 px-cell-x py-1.5 text-meta leading-base text-warn">
          Warden degraded: {view.wardenDegraded.reason}
        </p>
      )}
      {brokenBoards > 0 && (
        <p className="m-0 px-cell-x py-1.5 text-meta leading-base text-warn">
          {brokenBoards} attention board{brokenBoards === 1 ? '' : 's'} could not be read, so items on{' '}
          {brokenBoards === 1 ? 'it are' : 'them are'} missing here.
        </p>
      )}
      {view.verdictCoverage.truncated && (
        <p className="m-0 px-cell-x py-1.5 text-meta leading-base text-faint">
          Only the recent {view.verdictCoverage.limit} verdicts were read; older judgements may be missing.
        </p>
      )}
      {empty ? (
        <p className="m-0 px-cell-x py-row-y text-meta text-muted">{needsYouEmpty(view.outcome, stale)}</p>
      ) : (
        children
      )}
    </>
  );
}

function Group({
  title,
  count,
  empty,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly empty?: string;
  readonly children: ReactNode;
}) {
  const id = `warden-group-${title.toLowerCase().replaceAll(/[^a-z]+/gu, '-')}`;
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-xs">
      <h3 id={id} className="m-0 flex items-center gap-sm text-meta font-semibold uppercase tracking-wider text-muted">
        {title}
        <span className="font-normal text-faint">{count}</span>
      </h3>
      <div className="flex min-w-0 flex-col divide-y divide-border-soft overflow-hidden rounded-control border border-border-strong bg-surface">
        {empty !== undefined && count === 0 ? (
          <p className="m-0 px-cell-x py-row-y text-meta text-muted">{empty}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function SessionRow({
  connection,
  row,
  session,
  now,
  onNavigate,
  actions,
}: {
  readonly connection: DaemonConnection;
  readonly row: WardenRow;
  readonly session: SessionView | undefined;
  readonly now: number;
  readonly onNavigate: ((to: string) => void) | undefined;
  readonly actions: ReactNode;
}) {
  const name =
    session === undefined
      ? displayCallsign(row.teammate) || row.label || shortSessionId(row.sessionId)
      : sessionDisplayName(session);
  const place = session === undefined ? row.label : [folder(session), session.config.label].filter(Boolean).join(' · ');
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-sm sm:flex-nowrap" data-warden-row={row.key}>
      <RouteLink
        to={daemonSessionPath(connection.daemonId, row.sessionId)}
        {...(onNavigate === undefined ? {} : { onNavigate })}
        className="flex min-h-[44px] min-w-0 flex-1 basis-full items-start gap-sm px-cell-x py-row-y text-left no-underline hover:bg-surface-2 sm:basis-auto"
      >
        <span className="mt-[5px] inline-flex shrink-0">
          {session === undefined ? (
            <span aria-hidden="true" className="m-0.5 inline-block h-2 w-2 rounded-full bg-pend" />
          ) : (
            <StatusMark view={session} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-xs">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-sm">
            <span className="text-cell font-semibold text-fg">{name}</span>
            {place !== undefined && place !== '' && <span className="text-meta text-faint">{place}</span>}
          </span>
          <span className="whitespace-pre-wrap break-words text-cell leading-base text-fg-soft">{row.reason}</span>
          {row.detail !== undefined && <span className="text-meta leading-base text-faint">{row.detail}</span>}
          {row.chips.length > 0 && (
            <span className="flex flex-wrap gap-xs">
              {row.chips.map(entry => (
                <WardenChipBadge key={entry.label} chip={entry} />
              ))}
            </span>
          )}
        </span>
      </RouteLink>
      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-xs px-cell-x pb-row-y sm:py-row-y">
        {actions}
        {row.at !== undefined && <span className="text-meta text-faint">{relativeTime(row.at, now)}</span>}
      </div>
    </div>
  );
}

function AccountSummary({
  status,
  settingsHref,
  onNavigate,
}: {
  readonly status: WardenStatusView;
  readonly settingsHref: string;
  readonly onNavigate: ((to: string) => void) | undefined;
}) {
  const accounts = status.failover?.accounts ?? [];
  const inUse = status.failover?.lastSelection?.agent;
  return (
    <p className="m-0 flex flex-wrap items-center gap-xs text-meta text-muted">
      Warden accounts:
      {accounts.length === 0 ? (
        <span className="text-faint">none reported</span>
      ) : (
        accounts.map(account => <WardenChipBadge key={account.agent} chip={accountChip(account, inUse)} />)
      )}
      <RouteLink
        to={settingsHref}
        {...(onNavigate === undefined ? {} : { onNavigate })}
        className="inline-flex min-h-[44px] items-center font-semibold text-accent no-underline"
      >
        Edit in Settings ›
      </RouteLink>
    </p>
  );
}

const LEAVE_LABELS: Readonly<Record<WardenLeaveDuration, string>> = {
  '1h': 'For 1 hour',
  '4h': 'For 4 hours',
  until_change: 'Until it changes',
};

/**
 * "Leave it longer": the owner keeps the Warden off a flagged or cleared ferret for an hour, four, or
 * until its status changes. A native select, so it is one control at 44px on a phone and a keyboard
 * reaches every choice; picking one sends it at once.
 */
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
      className="kt-input min-h-[44px] max-w-[11rem] rounded-control border border-border bg-surface-2 px-2 text-meta text-fg"
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
