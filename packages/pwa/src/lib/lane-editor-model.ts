/**
 * THE LANE EDITOR'S DRAFT, as pure functions. A draft is a copy of a project's lanes the owner is changing:
 * nothing here talks to a daemon, and nothing throws. The page keeps one draft in state, calls a verb for
 * every change, and shows {@link draftProblems} live.
 *
 * - A RENAME CHANGES THE NAME, NEVER THE ID, so the cards in a lane keep their place.
 * - A DELETE NAMES WHERE ITS CARDS GO. {@link deleteLane} takes the target as a required argument and
 *   {@link draftProblems} (the protocol's `laneEditProblems`) still reports any lane removed with none.
 * - A VARIANT lists the lanes a workflow walks, always in lane order; a workflow with no entry walks every lane.
 */

import {
  type BoardResult,
  boardErr,
  boardOk,
  type Lane,
  type LaneCategory,
  LaneNameSchema,
  type LaneSet,
  type LaneTemplateName,
  type LaneTrigger,
  type LaneVariants,
  laneEditProblems,
  laneLayoutProblems,
  MAX_BOARD_LANES,
  MAX_LANE_ID_LENGTH,
  StaleAfterSchema,
  type TaskWorkflow,
  TaskWorkflowSchema,
} from '@ferretry/protocol';
import type { LaneWriteError } from './board-client.ts';

export interface LaneDraft {
  readonly lanes: readonly Lane[];
  readonly variants: LaneVariants;
  /** Where the cards of each removed lane go, by removed lane id. */
  readonly relocate: Readonly<Record<string, string>>;
}

/** One thing wrong with a draft; `laneId` is the lane it is about, `null` when it is about the set. */
export interface DraftProblem {
  readonly laneId: string | null;
  readonly message: string;
}

export type DeleteLaneError =
  | { readonly code: 'unknown-lane'; readonly laneId: string }
  | { readonly code: 'unknown-target'; readonly laneId: string }
  | { readonly code: 'last-lane' };

export const draftFromLaneSet = (laneSet: Pick<LaneSet, 'lanes' | 'variants'>): LaneDraft => ({
  lanes: laneSet.lanes,
  variants: laneSet.variants,
  relocate: {},
});

const laneIds = (lanes: readonly Lane[]): readonly string[] => lanes.map(lane => lane.id);

/** Each variant keeps only the lanes that exist, in the order the lanes are in. */
const settleVariants = (lanes: readonly Lane[], variants: LaneVariants): LaneVariants => {
  const order = laneIds(lanes);
  const settled: Record<string, string[]> = {};
  for (const [workflow, listed] of Object.entries(variants)) {
    const kept = order.filter(id => listed?.includes(id));
    if (kept.length > 0) settled[workflow] = kept;
  }
  return settled as LaneVariants;
};

const withLanes = (draft: LaneDraft, lanes: readonly Lane[], variants: LaneVariants = draft.variants): LaneDraft => ({
  ...draft,
  lanes,
  variants: settleVariants(lanes, variants),
});

const replaceLane = (draft: LaneDraft, id: string, change: (lane: Lane) => Lane): LaneDraft =>
  withLanes(
    draft,
    draft.lanes.map(lane => (lane.id === id ? change(lane) : lane)),
  );

/** Moves a lane one place earlier (`-1`) or later (`1`); the ends stay where they are. */
export const moveLane = (draft: LaneDraft, id: string, step: -1 | 1): LaneDraft => {
  const from = draft.lanes.findIndex(lane => lane.id === id);
  const to = from + step;
  const lane = draft.lanes[from];
  const other = draft.lanes[to];
  if (lane === undefined || other === undefined) return draft;
  const lanes = [...draft.lanes];
  lanes[from] = other;
  lanes[to] = lane;
  return withLanes(draft, lanes);
};

export const renameLane = (draft: LaneDraft, id: string, name: string): LaneDraft =>
  replaceLane(draft, id, lane => ({ ...lane, name }));

export const setLaneCategory = (draft: LaneDraft, id: string, category: LaneCategory): LaneDraft =>
  replaceLane(draft, id, lane => ({ ...lane, category }));

/** The triggers that move a card into the lane; none removes the field, which the protocol wants. */
export const setLaneTriggers = (draft: LaneDraft, id: string, triggers: readonly LaneTrigger[]): LaneDraft =>
  replaceLane(draft, id, ({ enterOn: _, ...lane }) =>
    triggers.length === 0 ? lane : { ...lane, enterOn: [...triggers] },
  );

export const setLaneOwnerGate = (draft: LaneDraft, id: string, ownerGate: boolean): LaneDraft =>
  replaceLane(draft, id, ({ ownerGate: _, ...lane }) => (ownerGate ? { ...lane, ownerGate: true } : lane));

/** A blank value removes the field (the category's default applies); anything else is kept as typed. */
export const setLaneStaleAfter = (draft: LaneDraft, id: string, staleAfter: string): LaneDraft =>
  replaceLane(draft, id, ({ staleAfter: _, ...lane }) =>
    staleAfter.trim() === '' ? lane : { ...lane, staleAfter: staleAfter.trim() },
  );

const slug = (name: string): string => {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (words === '') return 'lane';
  return /^[a-z]/u.test(words) ? words : `lane-${words}`;
};

/** A lane id for `name` that no lane of the draft has, within the protocol's length. */
export const freshLaneId = (lanes: readonly Lane[], name: string): string => {
  const taken = new Set(laneIds(lanes));
  const base = slug(name)
    .slice(0, MAX_LANE_ID_LENGTH - 4)
    .replace(/-+$/u, '');
  if (!taken.has(base)) return base;
  for (let count = 2; ; count += 1) {
    const candidate = `${base}-${String(count)}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/**
 * Adds an active lane just before the closed one (or at the end when there is none), and into every
 * workflow that has a list, so no workflow silently skips it. Refused past {@link MAX_BOARD_LANES}.
 */
export const addLane = (draft: LaneDraft, name = 'New lane'): LaneDraft => {
  if (draft.lanes.length >= MAX_BOARD_LANES) return draft;
  const lane: Lane = { id: freshLaneId(draft.lanes, name), name, category: 'active' };
  const closedAt = draft.lanes.findIndex(entry => entry.category === 'closed');
  const at = closedAt === -1 ? draft.lanes.length : closedAt;
  const lanes = [...draft.lanes.slice(0, at), lane, ...draft.lanes.slice(at)];
  const variants = Object.fromEntries(
    Object.entries(draft.variants).map(([workflow, listed]) => [workflow, [...(listed ?? []), lane.id]]),
  ) as LaneVariants;
  return withLanes(draft, lanes, variants);
};

/**
 * Removes a lane and says where its cards go. Cards already promised to this lane by an earlier delete go
 * to the same place, so no relocation ever points at a lane that is gone.
 */
export const deleteLane = (draft: LaneDraft, id: string, target: string): BoardResult<LaneDraft, DeleteLaneError> => {
  if (!draft.lanes.some(lane => lane.id === id)) return boardErr({ code: 'unknown-lane', laneId: id });
  if (draft.lanes.length === 1) return boardErr({ code: 'last-lane' });
  if (target === id || !draft.lanes.some(lane => lane.id === target)) {
    return boardErr({ code: 'unknown-target', laneId: target });
  }
  const lanes = draft.lanes.filter(lane => lane.id !== id);
  const redirected = Object.fromEntries(
    Object.entries(draft.relocate).map(([from, to]) => [from, to === id ? target : to]),
  );
  return boardOk({ ...withLanes(draft, lanes), relocate: { ...redirected, [id]: target } });
};

/** The lanes a workflow walks: its list, or every lane when it has none. */
export const workflowLanes = (draft: LaneDraft, workflow: TaskWorkflow): readonly string[] =>
  draft.variants[workflow] ?? laneIds(draft.lanes);

/** Puts a lane in or out of one workflow. A workflow keeps at least one lane. */
export const setWorkflowLane = (draft: LaneDraft, workflow: TaskWorkflow, id: string, included: boolean): LaneDraft => {
  const walked = workflowLanes(draft, workflow);
  if (walked.includes(id) === included) return draft;
  const next = included ? [...walked, id] : walked.filter(entry => entry !== id);
  return next.length === 0 ? draft : withLanes(draft, draft.lanes, { ...draft.variants, [workflow]: next });
};

/**
 * Everything wrong with a draft, live: each lane's name and duration, the layout rules the protocol owns
 * (`laneLayoutProblems`), and the lanes removed with no place for their cards (`laneEditProblems`).
 */
export const draftProblems = (current: Pick<LaneSet, 'lanes'>, draft: LaneDraft): readonly DraftProblem[] => {
  const problems: DraftProblem[] = [];
  for (const lane of draft.lanes) {
    const name = LaneNameSchema.safeParse(lane.name);
    if (!name.success) {
      problems.push({
        laneId: lane.id,
        message: lane.name.trim() === '' ? 'A lane needs a name.' : 'A lane name is one line of at most 40 characters.',
      });
    }
    if (lane.staleAfter !== undefined && !StaleAfterSchema.safeParse(lane.staleAfter).success) {
      problems.push({ laneId: lane.id, message: `"${lane.staleAfter}" is not a duration like 30m, 2h or 3d.` });
    }
  }
  if (draft.lanes.length > MAX_BOARD_LANES) {
    problems.push({ laneId: null, message: `A board has at most ${String(MAX_BOARD_LANES)} lanes.` });
  }
  for (const [, message] of laneLayoutProblems(draft)) {
    problems.push({ laneId: null, message: `${message.charAt(0).toUpperCase()}${message.slice(1)}.` });
  }
  for (const removed of laneEditProblems(current, { layout: draft, relocate: draft.relocate })) {
    const name = current.lanes.find(lane => lane.id === removed)?.name ?? removed;
    problems.push({ laneId: null, message: `Lane "${name}" was removed: choose where its cards go.` });
  }
  return problems;
};

/** The draft differs from the lanes it started as (a rename counts; so does a different order). */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
      : entry,
  );

/** The draft differs from the lanes it started as (a rename counts; so does a different order). */
export const draftChanged = (current: Pick<LaneSet, 'lanes' | 'variants'>, draft: LaneDraft): boolean =>
  canonical([current.lanes, current.variants]) !== canonical([draft.lanes, draft.variants]) ||
  Object.keys(draft.relocate).length > 0;

/** The request that saves a draft against the version it was made from. */
export const draftToEdit = (
  current: Pick<LaneSet, 'version'>,
  draft: LaneDraft,
): {
  readonly action: 'edit';
  readonly version: number;
  readonly layout: { lanes: Lane[]; variants: LaneVariants };
  readonly relocate: Readonly<Record<string, string>>;
} => ({
  action: 'edit',
  version: current.version,
  layout: {
    lanes: draft.lanes.map(lane => ({ ...lane, name: lane.name.trim() })),
    variants: draft.variants,
  },
  relocate: draft.relocate,
});

export const WORKFLOWS = TaskWorkflowSchema.options;

/** Each trigger in plain words, as the end of "Moves a card in when …". */
export const TRIGGER_LABELS: Readonly<Record<LaneTrigger, string>> = {
  'work.started': 'work starts',
  'pr.opened': 'a PR opens',
  'pr.ready': 'a PR is ready',
  'ci.green': 'CI passes',
  'pr.merged': 'the PR merges',
  'release.published': 'a release ships it',
  'release.running': 'this machine runs that release',
  'signal.done': 'the ferret says done',
};

/** Each lane category as the owner reads it. */
export const CATEGORY_LABELS: Readonly<Record<LaneCategory, string>> = {
  backlog: 'Backlog',
  active: 'Active',
  review: 'In review',
  shipped: 'Shipped',
  verify: 'To test (verify)',
  closed: 'Closed',
};

/** What each template is called on the picker. */
export const TEMPLATE_LABELS: Readonly<Record<LaneTemplateName, string>> = {
  'pr-release-verify': 'PR, release and verify',
  'pr-release': 'PR and release',
  pr: 'PR',
  ops: 'Ops',
  writing: 'Writing',
  quick: 'Quick',
};

/** A lane write's refusal as a sentence the owner can act on; the daemon's `code` picks the sentence. */
export const laneWriteMessage = (error: Pick<LaneWriteError, 'code' | 'message'>): string => {
  switch (error.code) {
    case 'version-conflict':
      return 'These lanes changed since you opened them. Reload to see the latest, then make your edit again.';
    case 'owner-only':
      return 'Only the owner can change confirmed lanes.';
    case 'already-confirmed':
      return 'These lanes are already confirmed.';
    case 'relocation-missing':
      return 'A removed lane needs a place for its cards.';
    case 'no-machine':
      return 'This machine is no longer paired.';
    default:
      return error.message;
  }
};
