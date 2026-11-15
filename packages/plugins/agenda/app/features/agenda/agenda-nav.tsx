/**
 * THE AGENDA'S WAY IN FROM A NAVIGATION COLUMN (`shell.navPanels['needs-you']`, S4): which ferrets wait on the owner is
 * this half's fact, so the part that says it is this half's, and the shell draws it under the nav entries. The Inbox
 * door's count is the shell's own pill, fed by this half's `navBadges.agenda` (`lib/agenda-nav-badge.ts`).
 *
 * - {@link NeedsYouGroup}: the column form: every ferret with an open item, newest first ({@link needsYouRows}). A ROW IS
 *   ONLY A WAY IN: it says what was asked and how many, and opens the ask page at its first open item. Nothing on a row
 *   answers, clears or hides an item — a Done on a row could not say which item it meant.
 * - {@link NeedsYouRail}: the rail form (`useNavForm`): one dot-badged icon per ferret, the same way in.
 *
 * A device panel is drawn under no shell, so a row names its page by the ask page's own path (`inboxTargetPath`), not by
 * another plugin's screen.
 */

import { Inbox } from 'lucide-react';
import { daemonHomeHref, RouteLink } from '../../shell.ts';
import type { DaemonId, SessionView } from '../../shell.ts';
import { agendaWords, UnreadBadge } from '../../components/unread-badge.tsx';
import { inboxTargetPath } from '../../lib/agenda-inbox.ts';
import { sessionsBarNames } from '../../lib/ferret-names.ts';

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

interface NeedsYouProps {
  readonly rows: readonly NeedsYouRow[];
  readonly isActive: (row: NeedsYouRow) => boolean;
  readonly onNavigate: (to: string) => void;
}

/** The ask page a row opens: its first open item, or the machine's Agenda page when the row carries no summary. */
const rowTarget = (row: NeedsYouRow): string => {
  const summary = row.view.state.agenda;
  return summary === undefined
    ? `${daemonHomeHref(row.daemonId)}/agenda`
    : inboxTargetPath(row.daemonId, row.view.config.id, summary.first);
};

const rowKey = (row: NeedsYouRow): string => `${row.daemonId}:${row.view.config.id}`;

export function NeedsYouGroup({
  rows,
  isActive,
  learns,
  onNavigate,
}: NeedsYouProps & {
  /** The ferret is in passive learning: its row says so. */
  readonly learns?: (row: NeedsYouRow) => boolean;
}) {
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
          return (
            <li key={rowKey(row)}>
              <RouteLink
                aria-current={isActive(row) ? 'page' : undefined}
                className="fy-sbar__row"
                data-learning-passive={learns?.(row) === true ? '' : undefined}
                data-sbar-needs-you={row.view.config.id}
                onNavigate={onNavigate}
                to={rowTarget(row)}
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

/** The narrow rail's form of the group: an icon per ferret with the count as a dot, and nothing when none waits. */
export function NeedsYouRail({ rows, isActive, onNavigate }: NeedsYouProps) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Needs you" className="fy-sbar__needs-rail" data-sbar-needs-you-rail="">
      <ul>
        {rows.map(row => {
          const summary = row.view.state.agenda;
          const names = sessionsBarNames(row.view);
          const who = names.ferret ?? names.title;
          const label = summary === undefined ? who : `${who} — ${agendaWords(summary.open)}`;
          return (
            <li key={rowKey(row)}>
              <RouteLink
                aria-current={isActive(row) ? 'page' : undefined}
                aria-label={label}
                className="fy-sbar__icon"
                data-sbar-needs-you={row.view.config.id}
                onNavigate={onNavigate}
                title={label}
                to={rowTarget(row)}
              >
                <Inbox aria-hidden="true" size={16} />
                {summary === undefined ? null : (
                  <UnreadBadge announce={false} className="fy-unread-badge--dot" count={summary.open} />
                )}
              </RouteLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One machine's ferrets, as the nav reads them: `sessions` is `null` before the first read. */
export interface NeedsYouMachine {
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly sessions: readonly SessionView[] | null;
}

/**
 * The rows of every machine, newest asked first. With one machine the heading says where, so a row names none; with
 * several each names its machine. A machine not read yet adds nothing: unread, never "nothing waiting".
 */
export const needsYouAcross = (machines: readonly NeedsYouMachine[]): readonly NeedsYouRow[] =>
  machines
    .flatMap(machine =>
      needsYouRows(machine.sessions ?? []).map(view => ({
        daemonId: machine.daemonId,
        view,
        ...(machines.length > 1 ? { machine: machine.name } : {}),
      })),
    )
    .sort((a, b) => (b.view.state.agenda?.latestAt ?? '').localeCompare(a.view.state.agenda?.latestAt ?? ''));
