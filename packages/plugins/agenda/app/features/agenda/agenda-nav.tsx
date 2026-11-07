/**
 * THE AGENDA'S WAYS IN FROM A NAVIGATION COLUMN (copied from today's sidebar: `sessions-bar-agenda.tsx`,
 * `sessions-bar-needs-you.tsx`, and the Needs you rule of `sessions-bar-model.ts`). Which ferrets wait on the owner,
 * and how many items the Inbox holds, are this half's facts, so the parts that say them are this half's; a shell
 * column that offers them a place draws them.
 *
 * - {@link AgendaNavEntry}: the Inbox door — an inbox icon, "Inbox" and the count badge; with nothing waiting it stays,
 *   calm ("Nothing waiting"), still a link. On a collapsed rail it is an icon with the badge on its corner.
 * - {@link NeedsYouGroup}: every ferret with an open item, newest first ({@link needsYouRows}). A ROW IS ONLY A WAY
 *   IN: it says what was asked and how many, and opens the conversation at its first open item. Nothing on a row
 *   answers, clears or hides an item — a Done on a row could not say which item it meant.
 *
 * GAP(agenda-nav): the 5.0 shell offers no navigation-column slot yet, so nothing mounts these until it does.
 */

import { Inbox } from 'lucide-react';
import { RouteLink } from '../../shell.ts';
import type { DaemonId, SessionView } from '../../shell.ts';
import { agendaWords, UnreadBadge } from '../../components/unread-badge.tsx';
import { useAgendaLinks } from '../../lib/agenda-links.ts';
import { sessionsBarNames } from '../../lib/ferret-names.ts';

export function AgendaNavEntry({
  total,
  href,
  current,
  rail,
  onNavigate,
}: {
  /** Open items across the Inbox. */
  readonly total: number;
  readonly href: string;
  /** The reader is on the Inbox page. */
  readonly current: boolean;
  /** The collapsed rail's icon button rather than the column's row. */
  readonly rail: boolean;
  readonly onNavigate: (to: string) => void;
}) {
  if (rail)
    return (
      <RouteLink
        aria-current={current ? 'page' : undefined}
        aria-label={total > 0 ? `Inbox — ${agendaWords(total)}` : 'Inbox — nothing waiting'}
        className="fy-sbar__icon fy-sbar__agenda-icon"
        data-sbar-agenda=""
        data-sbar-agenda-count={total}
        onNavigate={onNavigate}
        title={total > 0 ? `Inbox — ${agendaWords(total)}` : 'Inbox'}
        to={href}
      >
        <Inbox aria-hidden="true" size={16} />
        {total > 0 ? <UnreadBadge announce={false} className="fy-unread-badge--dot" count={total} /> : null}
      </RouteLink>
    );
  return (
    <RouteLink
      aria-current={current ? 'page' : undefined}
      className="fy-sbar__agenda"
      data-sbar-agenda=""
      data-sbar-agenda-count={total}
      data-sbar-unread={total > 0 ? '' : undefined}
      onNavigate={onNavigate}
      to={href}
    >
      <Inbox aria-hidden="true" size={15} />
      <span className="fy-sbar__agenda-name">Inbox</span>
      {total > 0 ? <UnreadBadge count={total} /> : <span className="fy-sbar__agenda-calm">Nothing waiting</span>}
    </RouteLink>
  );
}

/**
 * The ferrets Needs you lists: every one with an open item, whatever state it is in (an ended ferret's ask still
 * waits on the owner), newest `latestAt` first.
 */
export const needsYouRows = (views: readonly SessionView[]): readonly SessionView[] =>
  views
    .filter(view => (view.state.agenda?.open ?? 0) > 0)
    .sort((a, b) => (b.state.agenda?.latestAt ?? '').localeCompare(a.state.agenda?.latestAt ?? ''));

export interface NeedsYouRow {
  readonly daemonId: DaemonId;
  readonly view: SessionView;
  /** Names the machine on the row. Absent on a single machine's list, where the heading says it. */
  readonly machine?: string;
}

export function NeedsYouGroup({
  rows,
  isActive,
  learns,
  onNavigate,
}: {
  readonly rows: readonly NeedsYouRow[];
  readonly isActive: (row: NeedsYouRow) => boolean;
  /** The ferret is in passive learning: its row says so. */
  readonly learns: (row: NeedsYouRow) => boolean;
  readonly onNavigate: (to: string) => void;
}) {
  const links = useAgendaLinks();
  if (rows.length === 0) return null;
  return (
    <section aria-label="Needs you" className="fy-sbar__group fy-sbar__needs" data-sbar-needs-you-group="">
      <h2 className="fy-sbar__project">
        <span className="truncate">Needs you</span>
        <span className="fy-sbar__count">{rows.length}</span>
      </h2>
      <ul>
        {rows.map(row => {
          const summary = row.view.state.agenda;
          const names = sessionsBarNames(row.view);
          const chat = links.chat(row.daemonId, row.view.config.id);
          const to =
            summary === undefined
              ? chat
              : `${chat}${chat.includes('?') ? '&' : '?'}agenda=${encodeURIComponent(summary.first)}`;
          return (
            <li key={`${row.daemonId}:${row.view.config.id}`}>
              <RouteLink
                aria-current={isActive(row) ? 'page' : undefined}
                className="fy-sbar__row"
                data-learning-passive={learns(row) ? '' : undefined}
                data-sbar-needs-you={row.view.config.id}
                onNavigate={onNavigate}
                to={to}
              >
                <span className="fy-sbar__name truncate">{names.ferret ?? names.title}</span>
                {names.ferret === null ? null : <span className="fy-sbar__task truncate">{names.title}</span>}
                {summary === undefined ? null : <span className="fy-sbar__ask truncate">! {summary.ask}</span>}
                {row.machine === undefined ? null : <span className="fy-sbar__machine">{row.machine}</span>}
                {summary === undefined ? null : <UnreadBadge count={summary.open} />}
              </RouteLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
