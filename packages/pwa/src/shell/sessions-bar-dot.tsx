/**
 * ONE SESSION ON THE COLLAPSED RAIL: its status dot, as a link. A session with open Attention carries the
 * count badge ON the dot — the "<<" bar's version of an unread chat — and its link opens the conversation
 * AT the first open item (`?attention=A3`), so one tap goes where the badge points. The link's own label
 * says the count ("Hadi — 3 open Agenda items"), so the badge is not announced a second time.
 *
 * Unread dots are sorted first by the caller: the rail has no headings, so order is its only grouping.
 */

import type { SessionView } from '@ferretry/protocol';
import { unreadCount } from '../lib/agenda-inbox.ts';
import { displayCallsign } from '../lib/callsign.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { RouteLink } from './route-link.tsx';
import { agendaWords, sessionRowPath, sessionsBarSubline } from './sessions-bar-model.ts';
import { StatusMark } from './status-mark.tsx';
import { UnreadBadge } from './unread-badge.tsx';

export function SessionsRailDot({
  view,
  daemonId,
  machine,
  active,
  onNavigate,
}: {
  readonly view: SessionView;
  readonly daemonId: DaemonId;
  /** The machine's name, on a rail that lists several machines' sessions. */
  readonly machine?: string;
  readonly active: boolean;
  readonly onNavigate: (to: string) => void;
}) {
  const name = view.config.name || displayCallsign(view.config.teammate) || view.config.id;
  const where = machine === undefined ? name : `${name} on ${machine}`;
  const unread = unreadCount(view);
  return (
    <RouteLink
      aria-current={active ? 'page' : undefined}
      aria-label={unread > 0 ? `${where} — ${agendaWords(unread)}` : where}
      className="fy-sbar__dot"
      data-sbar-unread={unread > 0 ? '' : undefined}
      onNavigate={onNavigate}
      title={`${where} — ${sessionsBarSubline(view)}`}
      to={sessionRowPath(daemonId, view)}
    >
      <StatusMark view={view} />
      {unread > 0 ? <UnreadBadge announce={false} className="fy-unread-badge--dot" count={unread} /> : null}
    </RouteLink>
  );
}
