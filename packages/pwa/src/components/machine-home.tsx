/**
 * THE MACHINE HOME: what the selected machine is doing, in one calm screen. A line of five tappable
 * numbers (running, waiting on you, to test, spend today, health) and the few interactive ferrets to open
 * first — the ones that need you, then the most recently active — with one link to every session.
 *
 * It does not draw the Inbox's cards (a number here opens the Inbox, which owns decisions), the Fleet
 * checks strip (health is one tile) or the sessions table (that page is one tap away).
 */

import type { SessionView } from '@ferretry/protocol';
import { ArrowRight, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { unreadCount } from '../lib/agenda-inbox.ts';
import { cn } from '../lib/class-names.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import {
  daemonAgendaPath,
  daemonAnalyticsPath,
  daemonBoardPath,
  daemonNewSessionPath,
  daemonSessionsPath,
  daemonWardenPath,
} from '../lib/pages/routes.ts';
import { RouteLink } from '../shell/route-link.tsx';
import { rowPreview, sessionRowPath, sessionsBarDirectory, sessionsBarNames } from '../shell/sessions-bar-model.ts';
import { StatusMark } from '../shell/status-mark.tsx';
import { UnreadBadge } from '../shell/unread-badge.tsx';
import { type MachineHealth, machineCounts, topFerrets } from './machine-home-model.ts';
import { sessionAge } from './session-dashboard-model.ts';

export interface MachineHomeProps {
  readonly daemonId: DaemonId;
  readonly machineName: string;
  /** null is the first read; an empty list is an authoritative empty machine. */
  readonly sessions: readonly SessionView[] | null;
  /** Cards on this machine's board waiting for the owner to try them; null while unread. */
  readonly toTest: number | null;
  /** What today's sessions on this machine cost, in dollars; null when no price is known. */
  readonly spendTodayUsd: number | null;
  readonly health: MachineHealth | null;
  readonly now: number;
  readonly onNavigate?: (path: string) => void;
}

const TONE_DOT: Record<MachineHealth['tone'], string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  err: 'bg-err',
};

const dollars = (usd: number): string => (usd === 0 ? '$0' : `$${usd >= 100 ? Math.round(usd) : usd.toFixed(2)}`);

function Tile({
  to,
  onNavigate,
  label,
  value,
  sub,
  span,
  lit = false,
}: {
  readonly to: string;
  readonly onNavigate: ((path: string) => void) | undefined;
  readonly label: string;
  readonly value: ReactNode;
  readonly sub: string;
  readonly span: string;
  /** The one tile that asks for the owner: an accent edge, only while there is something to answer. */
  readonly lit?: boolean;
}) {
  return (
    <RouteLink
      className={cn(
        'flex min-h-[88px] min-w-0 flex-col justify-between rounded-panel border px-3 py-2.5 no-underline transition-colors',
        lit
          ? 'border-accent bg-accent-soft text-fg hover:bg-accent-soft'
          : 'border-border bg-surface text-fg hover:bg-surface-2',
        span,
      )}
      data-home-tile={label}
      onNavigate={onNavigate}
      to={to}
    >
      <span className="text-meta text-muted">{label}</span>
      <span className="font-display text-display font-bold leading-none tracking-display">{value}</span>
      <span className="line-clamp-2 text-meta text-faint">{sub}</span>
    </RouteLink>
  );
}

function FerretRow({
  view,
  daemonId,
  now,
  onNavigate,
}: {
  readonly view: SessionView;
  readonly daemonId: DaemonId;
  readonly now: number;
  readonly onNavigate: ((path: string) => void) | undefined;
}) {
  const { title, ferret } = sessionsBarNames(view);
  const unread = unreadCount(view);
  const ask = rowPreview(view);
  return (
    <li className="border-t border-border-soft first:border-t-0">
      <RouteLink
        className="grid min-h-[56px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-fg no-underline hover:bg-surface-2"
        data-home-ferret={view.config.id}
        onNavigate={onNavigate}
        to={sessionRowPath(daemonId, view)}
      >
        <span className="row-span-2 self-start pt-1">
          <StatusMark view={view} />
        </span>
        <span className={cn('truncate text-row', unread > 0 ? 'font-semibold' : 'font-medium')}>{title}</span>
        <span className="flex items-center gap-2 justify-self-end">
          {unread > 0 ? <UnreadBadge count={unread} /> : null}
          <span className="mono text-meta text-faint">{sessionAge(view.state.lastActivityAt, now)}</span>
        </span>
        <span className="col-span-2 truncate text-meta text-muted">
          {ask === undefined ? (
            <>
              {ferret === null ? null : <span className="text-fg-soft">{ferret} · </span>}
              <bdi>{sessionsBarDirectory(view)}</bdi>
            </>
          ) : (
            <span className="text-fg-soft">! {ask.text}</span>
          )}
        </span>
      </RouteLink>
    </li>
  );
}

export function MachineHome({
  daemonId,
  machineName,
  sessions,
  toTest,
  spendTodayUsd,
  health,
  now,
  onNavigate,
}: MachineHomeProps) {
  const allSessions = daemonSessionsPath(daemonId);
  const counts = sessions === null ? null : machineCounts(sessions);
  const ferrets = sessions === null ? [] : topFerrets(sessions);
  const dash = '—';

  return (
    <main aria-labelledby="machine-home-title" className="mx-auto w-full max-w-[880px] px-3 pb-6 pt-1 sm:px-0 sm:pt-3">
      <header className="mb-3 flex items-center justify-between gap-2 sm:mb-4">
        <div className="flex min-w-0 items-center gap-2">
          {health === null ? null : (
            <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', TONE_DOT[health.tone])} />
          )}
          <h1
            className="m-0 min-w-0 truncate font-display text-display font-bold tracking-display"
            id="machine-home-title"
          >
            {machineName}
          </h1>
        </div>
        <RouteLink
          aria-label="New session"
          className="kt-btn kt-btn--sm"
          data-variant="primary"
          onNavigate={onNavigate}
          to={daemonNewSessionPath(daemonId)}
        >
          <Plus aria-hidden="true" size={13} />
          <span className="sm:hidden">New</span>
          <span className="hidden sm:inline">New session</span>
        </RouteLink>
      </header>

      <section aria-label="Overview" className="grid grid-cols-6 gap-2 sm:grid-cols-5 sm:gap-3">
        <Tile
          label="Running"
          onNavigate={onNavigate}
          span="col-span-2 sm:col-span-1"
          sub={counts === null ? '' : `of ${counts.interactive} ferrets`}
          to={allSessions}
          value={counts === null ? dash : counts.running}
        />
        <Tile
          label="Needs you"
          lit={counts !== null && counts.waitingOnYou > 0}
          onNavigate={onNavigate}
          span="col-span-2 sm:col-span-1"
          sub={counts === null || counts.waitingOnYou === 0 ? 'all clear' : 'open Inbox'}
          to={daemonAgendaPath(daemonId)}
          value={counts === null ? dash : counts.waitingOnYou}
        />
        <Tile
          label="To test"
          onNavigate={onNavigate}
          span="col-span-2 sm:col-span-1"
          sub={toTest === null || toTest === 0 ? 'all clear' : 'on the board'}
          to={`${daemonBoardPath(daemonId)}?activity=to_test&machine=${encodeURIComponent(daemonId)}`}
          value={toTest ?? dash}
        />
        <Tile
          label="Spend today"
          onNavigate={onNavigate}
          span="col-span-3 sm:col-span-1"
          sub="this machine"
          to={daemonAnalyticsPath(daemonId)}
          value={spendTodayUsd === null ? dash : dollars(spendTodayUsd)}
        />
        <Tile
          label="Health"
          onNavigate={onNavigate}
          span="col-span-3 sm:col-span-1"
          sub={health?.detail ?? ''}
          to={daemonWardenPath(daemonId)}
          value={<span className="text-title font-semibold">{health?.word ?? dash}</span>}
        />
      </section>

      <section aria-labelledby="machine-home-ferrets" className="mt-5 sm:mt-6">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="m-0 text-title font-semibold" id="machine-home-ferrets">
            Interactive ferrets
          </h2>
          <RouteLink
            className="inline-flex min-h-[44px] items-center gap-1 text-cell text-accent no-underline hover:underline"
            data-home-all-sessions=""
            onNavigate={onNavigate}
            to={allSessions}
          >
            All {counts?.total ?? ''} sessions
            <ArrowRight aria-hidden="true" size={13} />
          </RouteLink>
        </div>
        {sessions !== null && ferrets.length === 0 ? (
          <p className="m-0 rounded-panel border border-dashed border-border bg-surface-2 px-4 py-8 text-center text-muted">
            No interactive ferrets are running here.
          </p>
        ) : (
          <ul className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0">
            {ferrets.map(view => (
              <FerretRow daemonId={daemonId} key={view.config.id} now={now} onNavigate={onNavigate} view={view} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
