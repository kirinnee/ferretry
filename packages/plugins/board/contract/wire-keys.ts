/**
 * THE `task…` WIRE KEYS (O18, owner !A539: "rename all to task"). A Board answer that names a work item says
 * `task`/`tasks` (the `--json` of `fy board` and `fy task show`, the HTTP bodies, the `board.changed` event), where the
 * daemon's own shapes still say `task` until the identifier rename. Two directions, both here and nowhere else:
 *
 *  - EMIT (`taskWire`): the daemon turns its own shape into the wire one at the route, once, by key.
 *  - READ (`readBoard`, `readTask`, …): a reader of our own JSON (this CLI, this app) takes either spelling for one
 *    release, so a daemon one build behind still answers it.
 *
 * Stored names never come through here: `state/board/cards/*.json`, the ask source `task`, `card-agenda:` and the
 * agenda and focus keys are read and written as they always were.
 */
import {
  BoardChangedSchema,
  type BoardMergeGateResponse,
  BoardMergeGateResponseSchema,
  type BoardResponse,
  BoardResponseSchema,
  type TaskResponse,
  CardResponseSchema,
  type TaskStartResponse,
  CardStartResponseSchema,
} from './wire.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` with the key `from` spelled `to`; a value that has no such key, or already has `to`, is returned as it is. */
const respelled = <T>(value: T, from: string, to: string): T => {
  if (!isRecord(value) || !(from in value) || to in value) return value;
  const { [from]: kept, ...rest } = value;
  return { ...rest, [to]: kept } as T;
};

/** What the daemon sends: the wire spelling of each answer that names a work item. */
export const taskWire = {
  board: (answer: BoardResponse): unknown => respelled(answer, 'cards', 'tasks'),
  card: (answer: TaskResponse): unknown => respelled(answer, 'card', 'task'),
  start: (answer: TaskStartResponse): unknown => respelled(answer, 'card', 'task'),
  mergeGate: (answer: BoardMergeGateResponse): unknown => ({
    ...answer,
    waits: answer.waits.map(wait => respelled(wait, 'card', 'task')),
  }),
};

/** What a reader takes in: either spelling becomes the daemon's own shape, which the schema then checks. */
const board = (raw: unknown): unknown => respelled(raw, 'tasks', 'cards');
const task = (raw: unknown): unknown => respelled(raw, 'task', 'card');
const mergeGate = (raw: unknown): unknown =>
  isRecord(raw) && Array.isArray(raw.waits)
    ? { ...raw, waits: raw.waits.map(wait => respelled(wait, 'task', 'card')) }
    : raw;

export const readBoard = (raw: unknown): BoardResponse => BoardResponseSchema.parse(board(raw));
export const readTask = (raw: unknown): TaskResponse => CardResponseSchema.parse(task(raw));
export const readMergeGate = (raw: unknown): BoardMergeGateResponse =>
  BoardMergeGateResponseSchema.parse(mergeGate(raw));

/** A `board.changed` payload: `taskIds`, or `cardIds` from a daemon one build behind. */
export const safeReadChanged = (raw: unknown): ReturnType<typeof BoardChangedSchema.safeParse> =>
  BoardChangedSchema.safeParse(respelled(raw, 'cardIds', 'taskIds'));

/** The same reads as a `safeParse`, for a caller that answers a refusal instead of throwing. */
export const safeReadTask = (raw: unknown): ReturnType<typeof CardResponseSchema.safeParse> =>
  CardResponseSchema.safeParse(task(raw));
export const safeReadTaskStart = (raw: unknown): ReturnType<typeof CardStartResponseSchema.safeParse> =>
  CardStartResponseSchema.safeParse(task(raw));
