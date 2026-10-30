/**
 * ONE SESSION IN THE SESSIONS BAR: the status mark, the task's name, one mark on the right, the ferret doing
 * it (an initial and its name) and the directory it runs in. The open one is a soft filled pill.
 *
 * Right-click, long-press, the Menu key and Shift+F10 open the bar's one row menu (`SessionMenuContext`).
 *
 * UNREAD. A session with open Attention (`state.attention`) reads like an unread chat: its name is bold,
 * an accent count badge sits on the right, and the row's link opens the conversation AT the first open
 * item (`?attention=A3`). The WHOLE row links there rather than the badge alone — an anchor cannot hold
 * a button, and one big target is the better thing to hit on a phone. The badge's number is spoken as
 * "3 open Agenda items" in the row's name, and it goes only when the items resolve.
 *
 * The mark on the right is the row's one exception: the unread badge, else a quiet "waiting" for a
 * ferret parked on a person, else the switch marks — the graduation cap of a ferret
 * that learns, then Hypermedia and Pack mode while each is on (`switch-marks.tsx`) — or,
 * inside the all-machines Needs you group, the machine's name (beside the badge, when there is one),
 * because every row there needs you and nothing else on the line says where it runs.
 */

import type { SessionView } from '@ferretry/protocol';
import { type ReactNode, useContext, useState } from 'react';
import { OutdatedMark } from '../features/restart-outdated/outdated-mark.tsx';
import { agendaOn, hypermediaOn, packOn } from '../features/session-info/info-model.ts';
import { SwitchMarks } from '../features/session-info/switch-marks.tsx';
import { unreadCount } from '../lib/agenda-inbox.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { MachineChip } from './machine-chip.tsx';
import { RouteLink } from './route-link.tsx';
import { useRowContextGesture } from './row-context-gesture.ts';
import { SessionMenuContext } from './session-menu-context.ts';
import {
  agendaWords,
  rowPreview,
  sessionRowPath,
  sessionsBarDirectory,
  sessionsBarNames,
} from './sessions-bar-model.ts';
import { StatusMark } from './status-mark.tsx';
import { UnreadBadge } from './unread-badge.tsx';

export function SessionsBarRow({
  view,
  daemonId,
  active,
  learningPassive,
  machine,
  onNavigate,
  depth,
  children,
}: {
  readonly view: SessionView;
  /** The machine the session runs on, which its link opens. */
  readonly daemonId: DaemonId;
  readonly active: boolean;
  readonly learningPassive: boolean;
  /** Names the machine on the row, in place of the badge. Only where nothing else says it. */
  readonly machine?: string;
  readonly onNavigate: (to: string) => void;
  /** Set on a row inside a branch of the tree: its indent, in steps. */
  readonly depth?: number;
  /** The branch beneath the row: its fold button and its children. */
  readonly children?: ReactNode;
}) {
  const { title: name, ferret } = sessionsBarNames(view);
  const directory = sessionsBarDirectory(view);
  const unread = unreadCount(view);
  const preview = rowPreview(view);
  const openMenu = useContext(SessionMenuContext);
  const [pressing, setPressing] = useState(false);
  const gesture = useRowContextGesture<SessionView>(
    openMenu === undefined ? undefined : (target, x, y, trigger) => openMenu({ view: target, daemonId }, x, y, trigger),
    view,
    setPressing,
  );
  return (
    <li data-sbar-depth={depth}>
      <RouteLink
        aria-current={active ? 'page' : undefined}
        className="fy-sbar__session"
        aria-haspopup={gesture === undefined ? undefined : 'menu'}
        data-sbar-pressing={pressing ? '' : undefined}
        data-sbar-session={view.config.id}
        data-sbar-unread={unread > 0 ? '' : undefined}
        onNavigate={onNavigate}
        {...gesture}
        title={`${name}${ferret === null ? '' : ` — ${ferret}`}${unread > 0 ? `\n${agendaWords(unread)}` : ''}${preview === undefined ? '' : `\n${preview.text}`}\n${view.config.cwd}`}
        to={sessionRowPath(daemonId, view)}
      >
        <StatusMark view={view} />
        <span className="fy-sbar__title">
          <span className="fy-sbar__name">{name}</span>
          <OutdatedMark view={view} />
        </span>
        {unread > 0 ? (
          <span className="fy-sbar__marks">
            {machine === undefined ? null : <MachineChip name={machine} />}
            <UnreadBadge count={unread} />
          </span>
        ) : machine !== undefined ? (
          <MachineChip name={machine} />
        ) : (
          <SwitchMarks
            agenda={agendaOn(view)}
            hypermedia={hypermediaOn(view)}
            learning={learningPassive}
            pack={packOn(view)}
          />
        )}
        {preview === undefined ? null : (
          <span
            className="fy-sbar__question"
            data-sbar-ask={preview.kind === 'attention' ? '' : undefined}
            data-sbar-question=""
          >
            {preview.text}
          </span>
        )}
        {/* One wrapper so a compact bar can fold the ferret and the directory into the open row's
            single second line; in the full bar it adds no box (`display: contents`). */}
        <span className="fy-sbar__detail" data-sbar-detail="">
          {ferret === null ? null : (
            <span className="fy-sbar__sub fy-sbar__ferret" data-sbar-ferret="">
              <span aria-hidden="true" className="fy-sbar__initial">
                {ferret.charAt(0).toUpperCase()}
              </span>
              <span className="fy-sbar__ferret-name">{ferret}</span>
            </span>
          )}
          {/* Truncated from the left (`direction: rtl`), so the folder's own name survives; `bdi` keeps
              the path's slashes reading left to right inside it. */}
          <span className="fy-sbar__dir" data-sbar-dir="">
            <bdi>{directory}</bdi>
          </span>
        </span>
      </RouteLink>
      {children}
    </li>
  );
}
