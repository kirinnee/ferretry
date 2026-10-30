import {
  type BoardActor,
  type BoardTaskEvent,
  type BoardTaskId,
  isBackwardMove,
  type LaneSet,
  type Task,
  type TaskActivity,
  type TaskLinkField,
} from '@ferretry/protocol';
import { laneForStatus, statusOfPhase } from './lane-for-status.ts';

const MAX_REASON = 2 * 1024;

export interface HistoryContext {
  readonly task: Task;
  readonly laneSet: LaneSet;
  /** Where each old id of this session now lives. An id missing from it names a card that was not imported. */
  readonly cardOf: ReadonlyMap<string, BoardTaskId>;
  readonly actorOf: (raw: string | null) => BoardActor;
}

const cut = (text: string): string => (text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text);

export type EventDraft = BoardTaskEvent extends infer E ? (E extends unknown ? Omit<E, 'seq'> : never) : never;
type Draft = EventDraft;

const note = (at: string, actor: BoardActor, text: string): Draft => ({ type: 'note', at, actor, text: cut(text) });

const movesBack = (laneSet: LaneSet, from: string, to: string): boolean => {
  const backward = isBackwardMove(laneSet, from, to);
  return backward.ok && backward.value;
};

const hasPullRequest = (task: Task): boolean => task.links.prs.length > 0;

const laneOfStatus = (context: HistoryContext, status: Task['status'], phase: Task['phase']): string =>
  laneForStatus(context.laneSet, {
    status: status === 'blocked' ? statusOfPhase(phase) : status,
    workflow: context.task.workflow,
    hasPullRequest: hasPullRequest(context.task),
  }).id;

const LINK_FIELD: Readonly<Record<TaskLinkField, 'pr' | 'branch' | 'commit' | 'doc'>> = {
  pr: 'pr',
  branch: 'branch',
  commit: 'commit',
  doc: 'doc',
};

/** One old activity as the v2 events it becomes (zero or more), tracking the lane the card is in. */
const eventsOf = (activity: TaskActivity, lane: { current: string }, context: HistoryContext): readonly Draft[] => {
  const at = activity.time;
  const actor = context.actorOf(activity.actor);
  const dependency = (id: string) => {
    const card = context.cardOf.get(id);
    return card === undefined || card === context.task.id ? undefined : { id: card };
  };
  switch (activity.type) {
    case 'created':
      return [];
    case 'status': {
      const { from, to, reason, phaseTo } = activity.data;
      const out: Draft[] = [];
      if (to === 'dropped') return [{ type: 'dropped', at, actor, reason: cut(reason) }];
      if (to === 'blocked') out.push({ type: 'blocked', at, actor, reason: cut(reason) });
      else if (from === 'blocked') out.push({ type: 'unblocked', at, actor, reason: cut(reason) });
      const target = laneOfStatus(context, to, phaseTo);
      if (target === lane.current) {
        if (out.length === 0) out.push(note(at, actor, `status ${from} → ${to}: ${reason}`));
        return out;
      }
      if (activity.data.reopened === true) {
        out.push({
          type: 'reopened',
          at,
          actor,
          from: lane.current,
          to: target,
          reason: cut(reason),
          ask: { text: cut(reason), source: 'migrated from the old task store' },
        });
      } else {
        out.push({
          type: 'moved',
          at,
          actor,
          from: lane.current,
          to: target,
          backward: movesBack(context.laneSet, lane.current, target),
          reason: cut(reason),
        });
      }
      lane.current = target;
      return out;
    }
    case 'note':
      return [note(at, actor, activity.data.text)];
    case 'feedback':
      return [note(at, actor, `feedback: ${activity.data.text}`)];
    case 'link':
      return [{ type: 'linked', at, actor, field: LINK_FIELD[activity.data.field], value: activity.data.value }];
    case 'assign':
      return [{ type: 'assigned', at, actor, from: activity.data.from, to: activity.data.to }];
    case 'order':
      return [{ type: 'ordered', at, actor, from: activity.data.from, to: activity.data.to }];
    case 'clarification':
      return [{ type: 'clarified', at, actor, text: activity.data.text, source: activity.data.source }];
    case 'dependency': {
      const target = dependency(activity.data.taskId);
      if (target === undefined) {
        return [note(at, actor, `dependency ${activity.data.operation} ${activity.data.taskId} (not imported)`)];
      }
      return activity.data.operation === 'add'
        ? [{ type: 'depended', at, actor, task: target, until: 'shipped' }]
        : [{ type: 'undepended', at, actor, task: target, reason: 'removed in the old task store' }];
    }
    case 'file':
      return activity.data.operation === 'add'
        ? [{ type: 'file-claimed', at, actor, path: activity.data.path }]
        : [{ type: 'file-released', at, actor, path: activity.data.path, reason: activity.data.reason ?? null }];
    case 'session':
      return [
        note(
          at,
          actor,
          activity.data.event === 'completion-claim'
            ? `completion claimed by ${activity.data.session} at turn ${activity.data.turn}`
            : `reopen acknowledged by ${activity.data.resolvedBy}`,
        ),
      ];
  }
};

export interface MappedHistory {
  /** The events, numbered 1…n, `created` first. `migrated` is not among them: the caller appends it. */
  readonly events: readonly BoardTaskEvent[];
}

/**
 * An old task's activity as v2 history. The card's FIRST lane comes from the status it was created with, and
 * each status change that lands in a different lane is a move (a move back says why, because every old status
 * change did). When the old record's final status disagrees with its own activity, one reconciling move closes
 * the gap, so the history never ends somewhere the card is not. Activity that failed to parse is absent.
 */
export const mapHistory = (
  context: HistoryContext,
  activity: readonly TaskActivity[],
  finalLane: string,
): MappedHistory => {
  const { task, laneSet } = context;
  const created = activity.find(
    (entry): entry is Extract<TaskActivity, { type: 'created' }> => entry.type === 'created',
  );
  const startLane = laneOfStatus(context, created?.data.status ?? 'todo', created?.data.phase ?? 'todo');
  const lane = { current: startLane };
  const drafts: Draft[] = [
    {
      type: 'created',
      at: created?.time ?? task.createdAt,
      actor: context.actorOf(created?.actor ?? task.createdBy),
      laneId: startLane,
    },
  ];
  for (const entry of activity) drafts.push(...eventsOf(entry, lane, context));
  if (lane.current !== finalLane) {
    drafts.push({
      type: 'moved',
      at: task.updatedAt,
      actor: { kind: 'daemon' },
      from: lane.current,
      to: finalLane,
      backward: movesBack(laneSet, lane.current, finalLane),
      reason: "migrated: the old record's status differs from its history",
    });
  }
  return { events: drafts.map((draft, index) => ({ ...draft, seq: index + 1 }) as BoardTaskEvent) };
};
