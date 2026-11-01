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
  type GateOption,
  GateOptionSchema,
  type GateOutcome,
  gateOptions,
  isExternalTrigger,
  type Lane,
  type LaneCategory,
  LaneNameSchema,
  type LaneSet,
  type LaneStage,
  type LaneTemplateName,
  type LaneTrigger,
  type LaneVariants,
  laneEditProblems,
  closedLaneProblems,
  laneLayoutProblems,
  laneStage,
  MAX_BOARD_LANES,
  MAX_GATE_LABEL_LENGTH,
  MAX_GATE_OPTIONS,
  MAX_LANE_ID_LENGTH,
  PLAN_GATE,
  StaleAfterSchema,
  type TaskWorkflow,
  TaskWorkflowSchema,
  VERIFY_GATE,
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

/**
 * A lane's stage survives a change of category when the new category can hold it: a gate is owner-gated
 * unless the lane is a verify lane (the owner's by category), and the closed lane is never a gate, so a gate
 * moved there is dropped and the lane reads the stage its fields describe. The emphasis follows the category.
 */
export const setLaneCategory = (draft: LaneDraft, id: string, category: LaneCategory): LaneDraft =>
  replaceLane(draft, id, ({ emphasis: _emphasis, ...lane }) => {
    const moved = { ...lane, category };
    if (moved.stage?.kind !== 'gate') return moved;
    if (category === 'closed') {
      const { stage: _stage, ...ungated } = moved;
      return ungated;
    }
    return category === 'verify' ? moved : { ...moved, ownerGate: true };
  });

/**
 * The triggers that move a card into the lane; none removes the field, which the protocol wants. An automatic
 * stage names the same triggers, so it is kept in step; a gate keeps its options (the triggers say how a card
 * enters the lane, the gate how it leaves).
 */
export const setLaneTriggers = (draft: LaneDraft, id: string, triggers: readonly LaneTrigger[]): LaneDraft =>
  replaceLane(draft, id, ({ enterOn: _, ...lane }) => {
    const kept =
      lane.stage?.kind === 'auto' ? { ...lane, stage: { kind: 'auto' as const, triggers: [...triggers] } } : lane;
    return triggers.length === 0 ? kept : { ...kept, enterOn: [...triggers] };
  });

/** Only the closed lane is switched by hand: its gate is its entrance. A stage the new gate would contradict is dropped. */
export const setLaneOwnerGate = (draft: LaneDraft, id: string, ownerGate: boolean): LaneDraft =>
  replaceLane(draft, id, ({ ownerGate: _, stage: _stage, ...lane }) =>
    ownerGate ? { ...lane, ownerGate: true } : lane,
  );

/** A blank value removes the field (the category's default applies); anything else is kept as typed. */
export const setLaneStaleAfter = (draft: LaneDraft, id: string, staleAfter: string): LaneDraft =>
  replaceLane(draft, id, ({ staleAfter: _, ...lane }) =>
    staleAfter.trim() === '' ? lane : { ...lane, staleAfter: staleAfter.trim() },
  );

/** Whether a lane has a stage switch: the closed lane is the owner's alone, so it has none. */
export const canSwitchStage = (lane: Pick<Lane, 'category'>): boolean => lane.category !== 'closed';

export const laneStageKind = (lane: Pick<Lane, 'category' | 'enterOn' | 'ownerGate' | 'stage'>): LaneStage['kind'] =>
  laneStage(lane).kind;

/**
 * Makes a lane a gate or an automatic step. A gate starts as the plan gate (the verify gate on a verify lane)
 * and owner-gates a lane that is not a verify lane; an automatic stage enters on the lane's own triggers and
 * is not owner-gated, which is what the protocol requires of the fields a stage mirrors. The closed lane has no
 * stage, and a lane already in that stage is left as it is.
 */
export const setLaneStageKind = (draft: LaneDraft, id: string, kind: LaneStage['kind']): LaneDraft =>
  replaceLane(draft, id, ({ emphasis: _emphasis, ...lane }) => {
    if (!canSwitchStage(lane) || laneStageKind(lane) === kind) return { emphasis: _emphasis, ...lane };
    if (kind === 'gate') {
      return lane.category === 'verify'
        ? { ...lane, stage: VERIFY_GATE }
        : { ...lane, stage: PLAN_GATE, ownerGate: true };
    }
    const { ownerGate: _ownerGate, ...open } = lane;
    return { ...open, stage: { kind: 'auto', triggers: [...(lane.enterOn ?? [])] } };
  });

/** Applies `change` to a gate's options; a lane that is not a gate, and a change that is no change, leave the draft alone. */
const changeGate = (
  draft: LaneDraft,
  id: string,
  change: (options: readonly GateOption[], lane: Lane) => readonly GateOption[],
): LaneDraft => {
  const lane = draft.lanes.find(entry => entry.id === id);
  if (lane === undefined || laneStageKind(lane) !== 'gate') return draft;
  const before = gateOptions(lane);
  const after = change(before, lane);
  if (after === before) return draft;
  return replaceLane(draft, id, entry => ({ ...entry, stage: { kind: 'gate', options: [...after] } }));
};

const optionSlug = (label: string): string => {
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_GATE_LABEL_LENGTH - 4)
    .replace(/-+$/gu, '');
  return /^[a-z]/u.test(words) ? words : 'option';
};

/** An option id for `label` that no option of the gate has. */
const freshOptionId = (options: readonly GateOption[], label: string): string => {
  const taken = new Set(options.map(option => option.id));
  const base = optionSlug(label);
  if (!taken.has(base)) return base;
  for (let count = 2; ; count += 1) {
    const candidate = `${base}-${String(count)}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** Adds an option that moves the card on, up to {@link MAX_GATE_OPTIONS}. */
export const addGateOption = (draft: LaneDraft, id: string): LaneDraft =>
  changeGate(draft, id, options =>
    options.length >= MAX_GATE_OPTIONS
      ? options
      : [...options, { id: freshOptionId(options, 'Option'), label: 'Option', outcome: { kind: 'next' } }],
  );

/** Removes an option; a gate keeps at least one. */
export const removeGateOption = (draft: LaneDraft, id: string, optionId: string): LaneDraft =>
  changeGate(draft, id, options =>
    options.length <= 1 || !options.some(option => option.id === optionId)
      ? options
      : options.filter(option => option.id !== optionId),
  );

/** A label as typed (the problems name a bad one live); an option's id never changes with its label. */
export const setGateOptionLabel = (draft: LaneDraft, id: string, optionId: string, label: string): LaneDraft =>
  changeGate(draft, id, options => options.map(option => (option.id === optionId ? { ...option, label } : option)));

/** Whether an option other than `exceptOptionId` already reopens with a conversation: a gate has one at most. */
export const reopenTaken = (
  lane: Pick<Lane, 'category' | 'enterOn' | 'ownerGate' | 'stage'>,
  exceptOptionId: string,
): boolean =>
  gateOptions(lane).some(option => option.id !== exceptOptionId && option.outcome.kind === 'reopen-with-agenda');

/** Points an option somewhere. A second reopen, and a lane that is the gate's own, are refused. */
export const setGateOptionOutcome = (draft: LaneDraft, id: string, optionId: string, outcome: GateOutcome): LaneDraft =>
  changeGate(draft, id, (options, lane) => {
    if (outcome.kind === 'reopen-with-agenda' && reopenTaken(lane, optionId)) return options;
    if (outcome.kind === 'lane' && outcome.laneId === id) return options;
    return options.map(option => (option.id === optionId ? { ...option, outcome } : option));
  });

/** What a gate option does, as the value a picker holds: `next`, `close`, `reopen` or `lane:<id>`. */
export const outcomeValue = (outcome: GateOutcome): string => {
  switch (outcome.kind) {
    case 'lane':
      return `lane:${outcome.laneId}`;
    case 'reopen-with-agenda':
      return 'reopen';
    default:
      return outcome.kind;
  }
};

export const outcomeFromValue = (value: string): GateOutcome | null => {
  if (value === 'next' || value === 'close') return { kind: value };
  if (value === 'reopen') return { kind: 'reopen-with-agenda' };
  const laneId = value.startsWith('lane:') ? value.slice('lane:'.length) : '';
  return laneId === '' ? null : { kind: 'lane', laneId };
};

/** Each kind of outcome as the owner reads it on the picker. */
export const OUTCOME_LABELS: Readonly<Record<GateOutcome['kind'], string>> = {
  next: 'Next lane',
  lane: 'A specific lane',
  'reopen-with-agenda': 'Not good (reopen and talk)',
  close: 'Close',
};

/** Whether a trigger is one somebody reports with `fy task trigger`, which Ferretry cannot see for itself. */
export const isReportedTrigger = (trigger: LaneTrigger): boolean => isExternalTrigger(trigger);

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

/** A gate option that named the removed lane goes where its cards go, or on when that is the gate's own lane. */
const retargetGate = (lane: Lane, removed: string, target: string): Lane => {
  if (lane.stage?.kind !== 'gate') return lane;
  const names = lane.stage.options.some(option => option.outcome.kind === 'lane' && option.outcome.laneId === removed);
  if (!names) return lane;
  const options = lane.stage.options.map(option =>
    option.outcome.kind === 'lane' && option.outcome.laneId === removed
      ? {
          ...option,
          outcome: target === lane.id ? ({ kind: 'next' } as const) : ({ kind: 'lane', laneId: target } as const),
        }
      : option,
  );
  return { ...lane, stage: { kind: 'gate', options } };
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
  const lanes = draft.lanes.filter(lane => lane.id !== id).map(lane => retargetGate(lane, id, target));
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

/** What is wrong with an option label as typed, or null when it is fine. */
export const gateLabelProblem = (label: string): string | null => {
  if (GateOptionSchema.shape.label.safeParse(label).success) return null;
  return label.trim() === ''
    ? 'An option needs a label.'
    : `An option label is one line of at most ${String(MAX_GATE_LABEL_LENGTH)} characters.`;
};

/**
 * Everything wrong with a draft, live: each lane's name and duration, the layout rules the protocol owns
 * (`laneLayoutProblems`, `closedLaneProblems`), and the lanes removed with no place for their cards (`laneEditProblems`).
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
    for (const option of lane.stage?.kind === 'gate' ? lane.stage.options : []) {
      const message = gateLabelProblem(option.label);
      if (message !== null) problems.push({ laneId: lane.id, message });
    }
  }
  if (draft.lanes.length > MAX_BOARD_LANES) {
    problems.push({ laneId: null, message: `A board has at most ${String(MAX_BOARD_LANES)} lanes.` });
  }
  for (const [, message] of [...laneLayoutProblems(draft), ...closedLaneProblems(draft)]) {
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
    lanes: draft.lanes.map(lane => ({
      ...lane,
      name: lane.name.trim(),
      ...(lane.stage?.kind === 'gate'
        ? {
            stage: {
              kind: 'gate' as const,
              options: lane.stage.options.map(option => ({ ...option, label: option.label.trim() })),
            },
          }
        : {}),
    })),
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
  'pr.review_approved': 'a reviewer approves the PR',
  'pr.merged': 'the PR merges',
  'release.published': 'a release ships it',
  'release.running': 'this machine runs that release',
  'signal.done': 'the ferret says done',
  'deploy.done': 'a deploy is reported done',
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
