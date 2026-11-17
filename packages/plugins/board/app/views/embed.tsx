/**
 * A `task` OR `board` BLOCK, DRAWN LIVE IN CHAT: the Board's own task and lane, read-only, inline in a message.
 *
 * Conversation owns the fence and hands the Board what it names (`reference:&board`, an `EmbedSpec`); everything drawn
 * is read from the board, so the block can never say something the board does not. The task is the real `BoardTask` and
 * the lane header the real `BoardLane`, the same ones the Board page, the phone and the Tasks tab draw.
 *
 *  - PROOF BEFORE LINK. A task that was read is a link to its page; one that was not (missing, unreadable, or not yet
 *    answered) is a quiet note or a placeholder and never a link.
 *  - LIVE, WITHOUT A TIMER. Each task is watched with `beat: false`, so it is re-read only when `board.changed` names it,
 *    and a block that unmounts lets go of its watch. A `parent:` block joins one shared whole-board read the same way.
 *  - Both list forms draw ONE mini board: the lanes with their tasks under them, at most `embedChildren` tasks.
 */

import { FY_RENDER_LIMITS } from '@ferretry/plugin-conversation/contract';
import { RouteLink, useNow } from '@ferretry/app/ui';
import { type ReactElement, type ReactNode, useMemo } from 'react';
import { useBoard, useBoardTask, useBoardTasks } from '../hooks/use-board.ts';
import { NO_BOARD_FILTERS } from '../lib/board-model.ts';
import type { FerretNames } from '../lib/board-present.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import type { BoardTaskOf } from '../lib/board-view.ts';
import {
  childLanes,
  type EmbedEntry,
  type EmbedLane,
  type EmbedSpec,
  embedTaskOf,
  groupEmbedLanes,
} from '../lib/embed-lanes.ts';
import { THIS_MACHINE } from '../lib/machine.ts';
import { navigateTo } from '../lib/navigate.ts';
import { boardTaskPath } from '../lib/paths.ts';
import { BoardTask } from './board-task.tsx';
import { BoardLane } from './board-lane.tsx';

export interface TaskEmbedProps {
  readonly store: DaemonBoardStore;
  readonly spec: EmbedSpec;
  readonly names: FerretNames;
}

/** Sub-cards are private bookkeeping, and a closed one is still a child worth showing. */
const CHILD_FILTERS = Object.freeze({ ...NO_BOARD_FILTERS, state: 'all' as const, agents: true });
const MACHINES = [{ connection: THIS_MACHINE, name: THIS_MACHINE.daemonId }] as const;

const note = (id: string, sentence: string): ReactElement => (
  <p className="fy-board-empty" data-embed-note={id} key={`note-${id}`} role="note">
    &{id} · {sentence}
  </p>
);

const loading = (id: string): ReactElement => (
  <div aria-hidden="true" className="fy-card-embed-loading" data-embed-loading={id} />
);

function Task({
  card: task,
  category,
  lane,
  names,
}: {
  readonly card: BoardTaskOf;
  readonly category: EmbedLane['category'];
  readonly lane?: string | undefined;
  readonly names: FerretNames;
}): ReactElement {
  const now = useNow();
  return (
    <BoardTask
      card={task}
      category={category}
      density="page"
      href={boardTaskPath(undefined, task.task.id)}
      names={names}
      now={now}
      onNavigate={navigateTo}
      showMachine={false}
      {...(lane === undefined ? {} : { lane })}
    />
  );
}

/** The one mini board both list forms draw: the lanes with their tasks, then the notes and a footer. */
function MiniBoard({
  anchor,
  lanes,
  notes,
  footer,
  names,
}: {
  readonly anchor: string;
  readonly lanes: readonly EmbedLane[];
  readonly notes: readonly ReactElement[];
  readonly footer: ReactNode;
  readonly names: FerretNames;
}): ReactElement {
  const total = lanes.reduce((sum, lane) => sum + lane.cards.length, 0);
  let budget = FY_RENDER_LIMITS.embedChildren;
  return (
    <div className="fy-card-embed-board" data-embed-board={anchor}>
      {lanes.map(lane => {
        const tasks = lane.cards.slice(0, Math.max(0, budget));
        budget -= tasks.length;
        if (tasks.length === 0) return null;
        return (
          <BoardLane category={lane.category} count={lane.cards.length} density="page" key={lane.key} name={lane.name}>
            {tasks.map(task => (
              <Task card={task} category={lane.category} key={task.key} names={names} />
            ))}
          </BoardLane>
        );
      })}
      {notes}
      {total > FY_RENDER_LIMITS.embedChildren ? (
        <p className="fy-card-embed-more">{total - FY_RENDER_LIMITS.embedChildren} more on the board.</p>
      ) : null}
      {footer}
    </div>
  );
}

function OneTask({
  store,
  id,
  names,
}: {
  readonly store: DaemonBoardStore;
  readonly id: string;
  readonly names: FerretNames;
}) {
  const state = useBoardTask(store, THIS_MACHINE, id, { beat: false });
  if (state.task === null) {
    if (state.missing) return note(id, 'No task with this id.');
    if (state.status === 'error') return note(id, 'This task could not be read.');
    return loading(id);
  }
  const { task } = state;
  const lane = state.laneSet?.lanes.find(candidate => candidate.id === task.laneId);
  return (
    <ul className="fy-card-embed-list" data-embed-card={task.id}>
      <Task card={embedTaskOf(task)} category={lane?.category ?? null} lane={lane?.name} names={names} />
    </ul>
  );
}

function ListedTasks({
  store,
  ids,
  names,
}: {
  readonly store: DaemonBoardStore;
  readonly ids: readonly string[];
  readonly names: FerretNames;
}) {
  const states = useBoardTasks(store, THIS_MACHINE, ids, { beat: false });
  const { lanes, notes, waiting } = useMemo(() => {
    const entries: EmbedEntry[] = [];
    const missing: ReactElement[] = [];
    let pending = 0;
    states.forEach((state, index) => {
      const id = ids[index] ?? '';
      if (state.task !== null) entries.push({ task: state.task, laneSet: state.laneSet });
      else if (state.missing) missing.push(note(id, 'No task with this id.'));
      else if (state.status === 'error') missing.push(note(id, 'This task could not be read.'));
      else pending += 1;
    });
    return { lanes: groupEmbedLanes(entries), notes: missing, waiting: pending };
  }, [states, ids]);
  const anchor = ids.join(' ');
  if (lanes.length === 0 && notes.length === 0) return loading(anchor);
  return (
    <MiniBoard
      anchor={anchor}
      footer={waiting > 0 ? loading(anchor) : null}
      lanes={lanes}
      names={names}
      notes={notes}
    />
  );
}

function ChildTasks({
  store,
  parent,
  names,
}: {
  readonly store: DaemonBoardStore;
  readonly parent: string;
  readonly names: FerretNames;
}) {
  const proof = useBoardTask(store, THIS_MACHINE, parent, { beat: false });
  const { model, status, machines } = useBoard(store, MACHINES, CHILD_FILTERS, { beat: false });
  const lanes = useMemo(() => childLanes(model, parent), [model, parent]);
  if (proof.task === null) {
    if (proof.missing) return note(parent, 'No task with this id.');
    if (proof.status === 'error') return note(parent, 'This task could not be read.');
    return loading(parent);
  }
  if (lanes.length === 0 && status !== 'ready' && status !== 'error') return loading(parent);
  const notes =
    lanes.length > 0
      ? []
      : [note(parent, status === 'error' ? 'Its tasks could not be read.' : 'No tasks under this one.')];
  const incomplete = machines.some(read => read.truncated) ? (
    <p className="fy-card-embed-more" data-embed-truncated={parent}>
      The board is too big to read in full, so this list may be incomplete.{' '}
      <RouteLink data-embed-parent-link={parent} onNavigate={navigateTo} to={boardTaskPath(undefined, parent)}>
        Open &{parent}
      </RouteLink>
    </p>
  ) : null;
  return <MiniBoard anchor={parent} footer={incomplete} lanes={lanes} names={names} notes={notes} />;
}

export function TaskEmbed({ store, spec, names }: TaskEmbedProps): ReactElement {
  if (spec.kind === 'card') return <OneTask id={spec.id} names={names} store={store} />;
  if (spec.kind === 'cards') return <ListedTasks ids={spec.ids} names={names} store={store} />;
  return <ChildTasks names={names} parent={spec.parent} store={store} />;
}
