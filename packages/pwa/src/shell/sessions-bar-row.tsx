/**
 * ONE SESSION IN THE SESSIONS BAR: the status mark, the task's name, one mark on the right, the ferret doing
 * it (an initial and its name) and the directory it runs in. The open one is a soft filled pill.
 *
 * Right-click, long-press, the Menu key and Shift+F10 open the bar's one row menu (`SessionMenuContext`).
 *
 * The mark on the right is the row's one exception: "needs you", else the switch marks — the graduation cap of a ferret
 * that learns, then Hypermedia and Pack mode while each is on (`switch-marks.tsx`) — or,
 * inside the all-machines Needs you group, the machine's name, because every row there needs you and
 * nothing else on the line says where it runs.
 */

import type { SessionView } from '@ferretry/protocol';
import { type ReactNode, useContext, useState } from 'react';
import { hypermediaOn, packOn } from '../features/session-info/info-model.ts';
import { SwitchMarks } from '../features/session-info/switch-marks.tsx';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { daemonSessionPath } from '../lib/pages/routes.ts';
import { MachineChip } from './machine-chip.tsx';
import { RouteLink } from './route-link.tsx';
import { useRowContextGesture } from './row-context-gesture.ts';
import { SessionMenuContext } from './session-menu-context.ts';
import { needsYou, pendingQuestionPreview, sessionsBarDirectory, sessionsBarNames } from './sessions-bar-model.ts';
import { StatusMark } from './status-mark.tsx';

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
  const waiting = needsYou(view);
  const directory = sessionsBarDirectory(view);
  const question = pendingQuestionPreview(view);
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
        onNavigate={onNavigate}
        {...gesture}
        title={`${name}${ferret === null ? '' : ` — ${ferret}`}${question === undefined ? '' : `\n${question}`}\n${view.config.cwd}`}
        to={daemonSessionPath(daemonId, view.config.id)}
      >
        <StatusMark view={view} />
        <span className="fy-sbar__name">{name}</span>
        {machine !== undefined ? (
          <MachineChip name={machine} />
        ) : waiting ? (
          <span className="fy-sbar__badge" data-sbar-needs-you="">
            needs you
          </span>
        ) : (
          <SwitchMarks hypermedia={hypermediaOn(view)} learning={learningPassive} pack={packOn(view)} />
        )}
        {question === undefined ? null : (
          <span className="fy-sbar__question" data-sbar-question="">
            {question}
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
