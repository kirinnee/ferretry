/**
 * ONE SESSION IN THE SESSIONS BAR: the status mark, the agent's name, one mark on the right, a line of
 * what it is doing and the directory it runs in. The open one is a soft filled pill.
 *
 * The mark on the right is the row's one exception: "needs you", else the graduation-cap mark of a ferret that learns — or,
 * inside the all-machines Needs you group, the machine's name, because every row there needs you and
 * nothing else on the line says where it runs.
 */

import type { SessionView } from '@ferretry/protocol';
import { PassiveLearningMark } from '../features/learning/passive-learning.tsx';
import { displayCallsign } from '../lib/callsign.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { daemonSessionPath } from '../lib/pages/routes.ts';
import { MachineChip } from './machine-chip.tsx';
import { RouteLink } from './route-link.tsx';
import { needsYou, pendingQuestionPreview, sessionsBarDirectory, sessionsBarSubline } from './sessions-bar-model.ts';
import { StatusMark } from './status-mark.tsx';

export function SessionsBarRow({
  view,
  daemonId,
  active,
  learningPassive,
  machine,
  onNavigate,
}: {
  readonly view: SessionView;
  /** The machine the session runs on, which its link opens. */
  readonly daemonId: DaemonId;
  readonly active: boolean;
  readonly learningPassive: boolean;
  /** Names the machine on the row, in place of the badge. Only where nothing else says it. */
  readonly machine?: string;
  readonly onNavigate: (to: string) => void;
}) {
  const name = displayCallsign(view.config.teammate) || view.config.label || view.config.id;
  const waiting = needsYou(view);
  const task = sessionsBarSubline(view);
  const directory = sessionsBarDirectory(view);
  const question = pendingQuestionPreview(view);
  return (
    <li>
      <RouteLink
        aria-current={active ? 'page' : undefined}
        className="fy-sbar__session"
        data-sbar-session={view.config.id}
        onNavigate={onNavigate}
        title={`${name} — ${task}${question === undefined ? '' : `\n${question}`}\n${view.config.cwd}`}
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
        ) : learningPassive ? (
          <PassiveLearningMark />
        ) : null}
        {question === undefined ? null : (
          <span className="fy-sbar__question" data-sbar-question="">
            {question}
          </span>
        )}
        {task === view.config.cwd ? null : <span className="fy-sbar__sub">{task}</span>}
        {/* Truncated from the left (`direction: rtl`), so the folder's own name survives; `bdi` keeps
            the path's slashes reading left to right inside it. */}
        <span className="fy-sbar__dir" data-sbar-dir="">
          <bdi>{directory}</bdi>
        </span>
      </RouteLink>
    </li>
  );
}
