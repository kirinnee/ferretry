/**
 * The Warden page body: what it did (stats, per-day chart), what it is doing (investigations, watching)
 * and a one-line way into the Warden's notifications in the Inbox.
 *
 * RENDER-ONLY. The daemon-bound host (`warden-overview-surface.tsx`) owns the reads, the sweep and the
 * leave requests; this draws what it is handed, so a test or a screenshot can drive every state. The
 * numbers and rows come from the models beside it.
 *
 * The page is quiet by design: stats first, then flat one-line lists — no card per row.
 */

import type { SessionView, WardenAttentionView, WardenLeaveDuration, WardenStatusView } from '@ferretry/protocol';
import { AlertTriangle, LoaderCircle, RefreshCw, ShieldCheck, SlidersHorizontal } from 'lucide-react';

import type { WardenReadState } from '../../hooks/use-warden-poll.ts';
import { readView } from '../../hooks/use-warden-poll.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonAttentionPath } from '../../lib/pages/routes.ts';
import { INSIGHTS_COLUMN_CLASS } from '../../shell/insights-frame.tsx';
import { Badge } from '../../shell/primitives.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { RecentActions } from './warden-action-rows.tsx';
import { WardenChipBadge } from './warden-chips.tsx';
import {
  accountChip,
  type WardenReportTarget,
  wardenHowItWorks,
  wardenInboxLine,
  wardenStatusLine,
  watchingRows,
} from './warden-overview-model.ts';
import { InvestigationList, WatchingList } from './warden-rows.tsx';
import { WardenStatsPanel } from './warden-stats.tsx';

export { WardenChipBadge };

/** A short-lived answer to something the owner just did: a sweep, a leave request. */
export interface WardenNotice {
  readonly tone: 'ok' | 'err';
  readonly text: string;
}

export interface WardenOverviewProps {
  readonly connection: DaemonConnection;
  readonly status: WardenReadState<WardenStatusView>;
  readonly attention: WardenReadState<WardenAttentionView>;
  /** This daemon's sessions, for names; `null` while not read yet. */
  readonly sessions?: readonly SessionView[] | null;
  readonly now: number;
  readonly sweeping?: boolean;
  readonly notice?: WardenNotice | null;
  /** Settings › Warden for this daemon. */
  readonly settingsHref: string;
  readonly onNavigate?: (to: string) => void;
  readonly onSweep: () => void;
  /** Leave a flagged or cleared ferret alone for longer. Absent: the control is not offered. */
  readonly onLeave?: (sessionId: string, duration: WardenLeaveDuration) => void;
  /** Sessions whose leave request is in flight. */
  readonly leaving?: ReadonlySet<string>;
  readonly onOpenReport: (target: WardenReportTarget) => void;
}

export function WardenOverview({
  connection,
  status,
  attention,
  sessions = null,
  now,
  sweeping = false,
  notice = null,
  settingsHref,
  onNavigate,
  onSweep,
  onLeave,
  leaving = new Set<string>(),
  onOpenReport,
}: WardenOverviewProps) {
  const statusView = readView(status);
  const bySession = new Map((sessions ?? []).map(session => [session.config.id, session]));
  const watching = statusView === undefined ? [] : watchingRows(statusView, readView(attention), now);
  const list = { connection, sessions: bySession, now, onNavigate };

  return (
    <div
      className={`${INSIGHTS_COLUMN_CLASS} flex min-w-0 flex-col gap-md pb-8 pt-3 sm:pt-4`}
      data-daemon={connection.daemonId}
    >
      <header className="flex min-w-0 flex-col gap-sm">
        <div className="flex flex-wrap items-center justify-between gap-x-md gap-y-sm">
          <h2 className="m-0 flex items-center gap-sm text-title font-semibold leading-tight text-fg">
            <ShieldCheck size={18} className="text-accent" aria-hidden="true" />
            Warden
          </h2>
          <div className="flex flex-wrap gap-sm">
            <button
              type="button"
              className="kt-btn kt-btn--sm min-h-[44px] sm:min-h-0"
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
              className="kt-btn kt-btn--sm min-h-[44px] no-underline sm:min-h-0"
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              Settings
            </RouteLink>
          </div>
        </div>
        <StatusSummary status={status} now={now} />
        {notice !== null && (
          <p
            role={notice.tone === 'err' ? 'alert' : 'status'}
            className={cn('m-0 text-meta leading-base', notice.tone === 'err' ? 'text-err' : 'text-muted')}
          >
            {notice.text}
          </p>
        )}
        <InboxLine connection={connection} attention={attention} onNavigate={onNavigate} />
      </header>

      {statusView !== undefined && (
        <>
          <WardenStatsPanel status={statusView} now={now} />
          <RecentActions
            connection={connection}
            status={statusView}
            sessions={bySession}
            now={now}
            onNavigate={onNavigate}
            onOpenReport={onOpenReport}
          />
          <InvestigationList {...list} status={statusView} onOpenReport={onOpenReport} />
          <WatchingList {...list} rows={watching} onLeave={onLeave} leaving={leaving} />
          <AccountSummary status={statusView} settingsHref={settingsHref} onNavigate={onNavigate} />
          <details className="text-meta text-muted">
            <summary className="min-h-[44px] cursor-pointer sm:min-h-0">How the Warden works</summary>
            <p className="m-0 mt-xs leading-base text-faint">{wardenHowItWorks(statusView.config.layers)}</p>
          </details>
        </>
      )}
    </div>
  );
}

function StatusSummary({ status, now }: { readonly status: WardenReadState<WardenStatusView>; readonly now: number }) {
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
  const line = wardenStatusLine(status.view, now);
  return (
    <div className="flex min-w-0 flex-col gap-xs">
      <p role="status" className="m-0 flex flex-wrap items-center gap-x-sm gap-y-xs text-ui leading-base text-fg">
        <span>
          <b className="font-semibold">{line.lead}</b> <span className="text-muted">{line.parts.join(' · ')}</span>
        </span>
        {line.warning !== undefined && (
          // Wraps rather than clipping: the warning is a sentence, and its end is the part that matters.
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
    </div>
  );
}

/** One quiet line into the Inbox, where the Warden's asks now live. */
function InboxLine({
  connection,
  attention,
  onNavigate,
}: {
  readonly connection: DaemonConnection;
  readonly attention: WardenReadState<WardenAttentionView>;
  readonly onNavigate: ((to: string) => void) | undefined;
}) {
  const line = wardenInboxLine(attention);
  if (line.kind === 'hidden') return null;
  if (line.kind === 'warning')
    return (
      <p role="status" className="m-0 text-meta leading-base text-warn" data-warden-inbox="warning">
        {line.text}
      </p>
    );
  if (line.kind === 'none')
    return (
      <p className="m-0 text-meta leading-base text-muted" data-warden-inbox="none">
        {line.text}
      </p>
    );
  return (
    <p className="m-0 text-meta leading-base" data-warden-inbox="link">
      <RouteLink
        // TODO(inbox-filter): switch to `/inbox?from=warden` once the Inbox filters by sender.
        to={daemonAttentionPath(connection.daemonId)}
        {...(onNavigate === undefined ? {} : { onNavigate })}
        className="inline-flex !min-h-8 !min-w-0 items-center font-semibold text-accent no-underline sm:!min-h-0"
      >
        {line.text} ›
      </RouteLink>
    </p>
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
        className="inline-flex min-h-[44px] items-center font-semibold text-accent no-underline sm:min-h-0"
      >
        Edit in Settings ›
      </RouteLink>
    </p>
  );
}
