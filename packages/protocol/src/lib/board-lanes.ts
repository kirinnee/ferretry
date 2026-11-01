/**
 * A PROJECT'S LANES: arbitrary names over a fixed set of categories.
 *
 * Every project board names its own columns, but automation, staleness, roll-up and filters reason only
 * over a lane's CATEGORY, so any project's lanes work without code (`board-design.md` §2.3). A lane set is
 * proposed by the first ferret that works in a project — from one of the templates below — and is live
 * at once; the owner confirms or edits it later.
 *
 * - **`verify` is the owner's clock.** A card there waits for a human check and is never stale.
 * - **`closed` is hidden** from the Kanban, and only the owner closes, except in a set with no `verify`
 *   lane, where the last lane may close on its own trigger.
 * - **Lane order is the direction.** A move to an earlier lane is backward and needs a reason.
 *
 * Every helper here is total: it returns a {@link BoardResult} and never throws.
 */
import { z } from 'zod';
import { BoardActorViaSchema, BoardProjectIdSchema, type BoardResult, boardErr, boardOk } from './board-refs.ts';
import { PositiveIntegerSchema } from './common.ts';
import { type TaskWorkflow, TaskWorkflowSchema } from './tasks.ts';

export const MAX_BOARD_LANES = 16;
export const MAX_LANE_NAME_LENGTH = 40;
export const MAX_LANE_ID_LENGTH = 32;

/** The semantics the daemon reasons over, in the order a card normally travels through them. */
export const LANE_CATEGORIES = ['backlog', 'active', 'review', 'shipped', 'verify', 'closed'] as const;
export const LaneCategorySchema = z.enum(LANE_CATEGORIES);
export type LaneCategory = z.infer<typeof LaneCategorySchema>;

/**
 * The real signals that move a card by themselves (`board-design.md` §3.1). Most are facts Ferretry sees for
 * itself; the {@link EXTERNAL_LANE_TRIGGERS} happen where it cannot look, and somebody reports them.
 */
export const LaneTriggerSchema = z.enum([
  'work.started',
  'pr.opened',
  'pr.ready',
  'ci.green',
  'pr.review_approved',
  'pr.merged',
  'release.published',
  'release.running',
  'signal.done',
  'deploy.done',
]);
export type LaneTrigger = z.infer<typeof LaneTriggerSchema>;

/**
 * The triggers Ferretry cannot see, so a card's owner or one of its ferrets REPORTS them (the task action
 * `trigger`): a deploy finished somewhere Ferretry does not run, or a reviewer approved the PR (the watcher
 * reads a PR's state, checks and merge, not its reviews). Every other trigger is a fact the daemon observes
 * itself and nobody may claim: a merge or a release is read from GitHub, never taken on a caller's word.
 */
export const EXTERNAL_LANE_TRIGGERS = ['pr.review_approved', 'deploy.done'] as const satisfies readonly LaneTrigger[];
export const ExternalLaneTriggerSchema = z.enum(EXTERNAL_LANE_TRIGGERS);
export type ExternalLaneTrigger = z.infer<typeof ExternalLaneTriggerSchema>;

/** Whether a trigger is one somebody reports rather than one the daemon observes. */
export const isExternalTrigger = (trigger: LaneTrigger): trigger is ExternalLaneTrigger =>
  (EXTERNAL_LANE_TRIGGERS as readonly LaneTrigger[]).includes(trigger);

/** A lane's stable id. A rename changes the lane's name, never its id, so cards keep their place. */
export const LaneIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/u, 'a lane id is lowercase letters, digits and dashes')
  .max(MAX_LANE_ID_LENGTH);
export type LaneId = z.infer<typeof LaneIdSchema>;

export const LaneNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_LANE_NAME_LENGTH)
  .refine(value => !/[\r\n]/u.test(value), 'a lane name is one line');

/**
 * How long a card may sit untouched in a lane before it is stale: a count of minutes, hours or days
 * (`30m`, `2h`, `3d`). Written the way the owner reads it in the lane editor; {@link staleAfterMinutes}
 * turns it into an amount.
 */
export const StaleAfterSchema = z.string().regex(/^[1-9][0-9]{0,3}[mhd]$/u, 'a duration like 30m, 2h or 3d');
export type StaleAfter = z.infer<typeof StaleAfterSchema>;

const MINUTES_PER_UNIT: Readonly<Record<string, number>> = { m: 1, h: 60, d: 24 * 60 };

/** The amount a {@link StaleAfter} names, in minutes. */
export const staleAfterMinutes = (value: StaleAfter): number =>
  Number(value.slice(0, -1)) * (MINUTES_PER_UNIT[value.slice(-1)] ?? 0);

/**
 * How the Board draws a lane, by what the owner does there (`docs/board.md` § The lane design rule):
 * lanes are about ACTION first, with just enough progress to show things move.
 *
 * - `action`: the owner has something to do here (test a release, approve a plan). Drawn prominent.
 * - `progress`: work is moving (Todo, In progress). Drawn as an ordinary lane.
 * - `info`: information only (Merged, Closed). Drawn compact.
 */
export const LaneEmphasisSchema = z.enum(['action', 'progress', 'info']);
export type LaneEmphasis = z.infer<typeof LaneEmphasisSchema>;

// ---------------------------------------------------------------------------------------------------
// Stages: what a lane IS in a project's workflow — a gate the owner answers, or a step that moves on its own.
// ---------------------------------------------------------------------------------------------------

export const MAX_GATE_OPTIONS = 3;
export const MAX_GATE_LABEL_LENGTH = 24;

/**
 * Where a gate's option sends the card:
 *
 * - `next`: the next lane of the card's variant (`nextLane`).
 * - `lane`: a lane of the set, named.
 * - `reopen-with-agenda`: back to the set's `notGoodLane`. The owner's words are required, and a
 *   conversation about them follows.
 * - `close`: the set's `doneLane`.
 */
export const GateOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('next') }),
  z.strictObject({ kind: z.literal('lane'), laneId: LaneIdSchema }),
  z.strictObject({ kind: z.literal('reopen-with-agenda') }),
  z.strictObject({ kind: z.literal('close') }),
]);
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;

/** One answer to a gate: what the owner presses, and where it sends the card. */
export const GateOptionSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/u, 'an option id is lowercase letters, digits and dashes')
    .max(MAX_GATE_LABEL_LENGTH),
  label: z
    .string()
    .trim()
    .min(1)
    .max(MAX_GATE_LABEL_LENGTH)
    .refine(value => !/[\r\n]/u.test(value), 'an option label is one line'),
  outcome: GateOutcomeSchema,
});
export type GateOption = z.infer<typeof GateOptionSchema>;

/**
 * A lane's stage in the workflow.
 *
 * - **`gate`** — the owner decides how the card leaves: 1–3 options, which the Inbox draws as →, ← and a
 *   button. Option ids are unique and at most one reopens with an agenda conversation. A gate lane is still
 *   ENTERED the way any lane is, on its `enterOn` triggers; its stage says how a card leaves it.
 * - **`auto`** — the card moves in by itself on its `triggers`; none means the ferret moves it there.
 */
export const LaneStageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('gate'),
    options: z
      .array(GateOptionSchema)
      .min(1)
      .max(MAX_GATE_OPTIONS)
      .refine(options => new Set(options.map(option => option.id)).size === options.length, 'option ids are unique')
      .refine(
        options => options.filter(option => option.outcome.kind === 'reopen-with-agenda').length <= 1,
        'a gate reopens with an agenda conversation at most once',
      ),
  }),
  z.strictObject({
    kind: z.literal('auto'),
    triggers: z
      .array(LaneTriggerSchema)
      .refine(triggers => new Set(triggers).size === triggers.length, 'a stage names each trigger once'),
  }),
]);
export type LaneStage = z.infer<typeof LaneStageSchema>;

/** The gate of a lane the owner approves before the work goes on: a plan or a design. */
export const PLAN_GATE: LaneStage = {
  kind: 'gate',
  options: [{ id: 'ok', label: 'OK to build', outcome: { kind: 'next' } }],
};

/** The gate of a lane the owner tests: Done closes it, Not good sends it back with the owner's words. */
export const VERIFY_GATE: LaneStage = {
  kind: 'gate',
  options: [
    { id: 'done', label: 'Done', outcome: { kind: 'close' } },
    { id: 'not-good', label: 'Not good', outcome: { kind: 'reopen-with-agenda' } },
  ],
};

const sameTriggers = (left: readonly LaneTrigger[], right: readonly LaneTrigger[]): boolean =>
  left.length === right.length && left.every(trigger => right.includes(trigger));

/**
 * A lane's stage: the one it stores, else the one its compatibility fields describe, so every lane has one.
 * Pure and total.
 *
 * - A `closed` lane is automatic: the owner enters it (an owner-gated closed lane's gate is its entrance), or
 *   its own `enterOn` does in a set with no verify lane.
 * - A `verify` lane is {@link VERIFY_GATE}, owner-gated or not: a verify lane is the owner's by its category.
 * - Any other owner-gated lane is {@link PLAN_GATE}.
 * - Anything else moves on its `enterOn`.
 */
export const laneStage = (lane: Pick<Lane, 'category' | 'enterOn' | 'ownerGate' | 'stage'>): LaneStage => {
  if (lane.stage !== undefined) return lane.stage;
  if (lane.category === 'verify') return VERIFY_GATE;
  if (lane.category !== 'closed' && lane.ownerGate === true) return PLAN_GATE;
  return { kind: 'auto', triggers: [...(lane.enterOn ?? [])] };
};

/** A lane's gate options, in the order the owner reads them; none for an automatic stage. */
export const gateOptions = (
  lane: Pick<Lane, 'category' | 'enterOn' | 'ownerGate' | 'stage'>,
): readonly GateOption[] => {
  const stage = laneStage(lane);
  return stage.kind === 'gate' ? stage.options : [];
};

/**
 * A lane that declares a stage, with its compatibility fields filled from it: a gate is owner-gated (a
 * `verify` lane is the owner's by category, so its `ownerGate` is left as it is), an automatic stage enters
 * on its triggers. Only what is MISSING is filled; a field that disagrees is left for the schema to refuse.
 * Anything else passes through untouched.
 */
const withStageMirrors = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || !('stage' in value)) return value;
  const lane = value as Record<string, unknown>;
  const stage = LaneStageSchema.safeParse(lane['stage']);
  if (!stage.success) return value;
  if (stage.data.kind === 'gate') {
    return lane['ownerGate'] === undefined && lane['category'] !== 'verify' ? { ...lane, ownerGate: true } : value;
  }
  return lane['enterOn'] === undefined && stage.data.triggers.length > 0
    ? { ...lane, enterOn: [...stage.data.triggers] }
    : value;
};

/** Where a lane's stage and its compatibility fields disagree, as messages; empty when they agree. */
const stageMirrorProblems = (lane: Lane): readonly string[] => {
  const { stage } = lane;
  if (stage === undefined) return [];
  if (stage.kind === 'gate') {
    if (lane.category === 'closed') return ['a closed lane is the end of the workflow, never a gate'];
    return lane.ownerGate === true || lane.category === 'verify' ? [] : ['a gate is owner-gated'];
  }
  const problems: string[] = [];
  if (!sameTriggers(lane.enterOn ?? [], stage.triggers)) problems.push('an automatic stage enters on its triggers');
  if (lane.category !== 'closed' && lane.ownerGate === true) {
    problems.push('an automatic stage is not owner-gated: a lane the owner passes is a gate');
  }
  return problems;
};

/**
 * One column.
 *
 * - `stage`: a gate the owner answers, or an automatic step ({@link laneStage}). Optional: a lane without one
 *   reads the stage its `enterOn` and `ownerGate` describe. Those two stay the compatibility mirror, so an
 *   app that predates stages, and every helper here, reads a staged lane correctly: a lane that declares a
 *   stage gets whichever mirror it leaves out, and is refused when one disagrees.
 * - `enterOn`: the triggers that move a card INTO this lane. Several lanes may name the same trigger;
 *   a card goes to the first one in its workflow's variant ({@link laneForTrigger}).
 * - `ownerGate`: only the owner passes this lane's gate. For a `closed` lane the gate is its ENTRANCE
 *   (only the owner closes); for any other lane it is the forward EXIT (only the owner, or the owner's
 *   approval, moves a card on). See {@link needsOwner}.
 * - `staleAfter`: absent means the category's default (a `verify` lane is never stale).
 * - `emphasis`: how prominently the Board draws it; absent means {@link laneEmphasis}'s default.
 */
const LaneObjectSchema = z.object({
  id: LaneIdSchema,
  name: LaneNameSchema,
  category: LaneCategorySchema,
  enterOn: z
    .array(LaneTriggerSchema)
    .min(1)
    .refine(triggers => new Set(triggers).size === triggers.length, 'a lane names each trigger once')
    .optional(),
  ownerGate: z.boolean().optional(),
  staleAfter: StaleAfterSchema.optional(),
  emphasis: LaneEmphasisSchema.optional(),
  stage: LaneStageSchema.optional(),
});

export const LaneSchema = z.preprocess(
  withStageMirrors,
  LaneObjectSchema.superRefine((lane, context) => {
    for (const message of stageMirrorProblems(lane)) context.addIssue({ code: 'custom', message, path: ['stage'] });
  }),
);
export type Lane = z.infer<typeof LaneObjectSchema>;

/** The lane ids each workflow walks, in lane order. A workflow with no entry walks every lane. */
export const LaneVariantsSchema = z.partialRecord(TaskWorkflowSchema, z.array(LaneIdSchema).min(1));
export type LaneVariants = z.infer<typeof LaneVariantsSchema>;

/**
 * The lanes the owner's two verdicts send a card to: `doneLane` (Done, Works) is the set's `closed` lane,
 * and `notGoodLane` (Not good) is the `active` lane work resumes in, e.g. Implement. Declared, not guessed,
 * so the Kanban, the Table and the card detail all send a card to the same place.
 */
const LaneTargetsShape = {
  doneLane: LaneIdSchema,
  notGoodLane: LaneIdSchema,
};

/** The lanes and variants, before they belong to a project: a template, or the body of an edit. */
const LaneLayoutShape = {
  lanes: z.array(LaneSchema).min(1).max(MAX_BOARD_LANES),
  variants: LaneVariantsSchema,
  /** Absent in an edit from an app that predates them: the set keeps its own, or {@link laneTargets} derives them. */
  doneLane: LaneTargetsShape.doneLane.optional(),
  notGoodLane: LaneTargetsShape.notGoodLane.optional(),
};

type LaneLayout = {
  readonly lanes: readonly Lane[];
  readonly variants: LaneVariants;
  readonly doneLane?: string | undefined;
  readonly notGoodLane?: string | undefined;
};

/** The lane Done and Not good go to. */
export interface LaneTargets {
  readonly doneLane: LaneId;
  readonly notGoodLane: LaneId;
}

/**
 * The emphasis a lane is drawn with: the one it declares, else its category's. A `verify` lane, an
 * owner-gated lane and nothing else asks the owner to act; `shipped` and `closed` lanes are information.
 */
export const laneEmphasis = (lane: Pick<Lane, 'category' | 'ownerGate' | 'emphasis'>): LaneEmphasis => {
  if (lane.emphasis !== undefined) return lane.emphasis;
  if (lane.category === 'verify') return 'action';
  if (lane.category === 'shipped' || lane.category === 'closed') return 'info';
  return lane.ownerGate === true ? 'action' : 'progress';
};

/** What puts a card in a lane by itself, in the words `fy board lanes show` prints. */
const TRIGGER_WORDS: Readonly<Record<LaneTrigger, string>> = {
  'work.started': 'a session starts on it',
  'pr.opened': 'a PR opens',
  'pr.ready': 'a PR is ready',
  'ci.green': 'checks pass',
  'pr.review_approved': 'a reviewer approves the PR (reported)',
  'pr.merged': 'the PR merges',
  'release.published': 'a release ships it',
  'release.running': 'its release runs here',
  'signal.done': '`fy signal done`',
  'deploy.done': 'a deploy finishes (reported)',
};

/** When a card belongs in a lane, by its category alone, so any project's lane names are covered. */
export const LANE_CATEGORY_USE: Readonly<Record<LaneCategory, string>> = {
  backlog: 'not started yet',
  active: 'you are building it now',
  review: 'built and waiting to be reviewed',
  shipped: 'merged, waiting for a release',
  verify: 'the owner tests it',
  closed: 'finished; only the owner closes it',
};

/** The category use of an active lane the owner gates: a plan or design, before the building starts. */
const PLAN_USE = 'you are planning or designing it; the owner approves before it moves on';

/**
 * One lane's "use when …" line: its category's meaning, what moves a card in by itself, and who passes its
 * gate. A lane nothing enters by itself says the ferret moves a card there. Pure and total.
 */
export const laneUse = (lane: Pick<Lane, 'category' | 'enterOn' | 'ownerGate'>): string => {
  const planning = lane.category === 'active' && lane.ownerGate === true;
  const base = planning ? PLAN_USE : LANE_CATEGORY_USE[lane.category];
  const gated = lane.ownerGate === true && !planning && lane.category !== 'closed';
  const entry =
    lane.enterOn === undefined
      ? lane.category === 'backlog' || lane.category === 'closed'
        ? null
        : 'move it here yourself'
      : `moves in when ${lane.enterOn.map(trigger => TRIGGER_WORDS[trigger]).join(' or ')}`;
  return [base, entry, gated ? 'the owner moves it on' : null].filter(part => part !== null).join('; ');
};

/**
 * Where Done and Not good go when a set does not say: the closed lane, and the LAST active lane (work
 * resumes where it is finished, after any plan step) — the first backlog lane in a set with no active one.
 * `undefined` for a lane list no lane set could have (no closed or no backlog lane).
 */
export const defaultLaneTargets = (lanes: readonly Pick<Lane, 'id' | 'category'>[]): LaneTargets | undefined => {
  const done = lanes.find(lane => lane.category === 'closed');
  const notGood = lanes.findLast(lane => lane.category === 'active') ?? lanes.find(lane => lane.category === 'backlog');
  return done === undefined || notGood === undefined ? undefined : { doneLane: done.id, notGoodLane: notGood.id };
};

/** Whether `notGoodLane` may be this lane: an active lane, or a backlog lane in a set with no active one. */
const mayResumeIn = (lanes: readonly Pick<Lane, 'category'>[], lane: Pick<Lane, 'category'>): boolean =>
  lane.category === 'active' || (lane.category === 'backlog' && !lanes.some(other => other.category === 'active'));

/**
 * A layout's targets: the ones it declares, else the previous set's while they still fit (a lane kept, in
 * the right category), else {@link defaultLaneTargets}. `undefined` only for a layout no set could have.
 */
export const laneTargets = (layout: LaneLayout, previous?: Partial<LaneTargets>): LaneTargets | undefined => {
  const fallback = defaultLaneTargets(layout.lanes);
  if (fallback === undefined) return undefined;
  const byId = (id: string | undefined): Lane | undefined =>
    id === undefined ? undefined : layout.lanes.find(lane => lane.id === id);
  const carriedDone = byId(previous?.doneLane)?.category === 'closed' ? previous?.doneLane : undefined;
  const carriedNotGood = byId(previous?.notGoodLane);
  return {
    doneLane: layout.doneLane ?? carriedDone ?? fallback.doneLane,
    notGoodLane:
      layout.notGoodLane ??
      (carriedNotGood !== undefined && mayResumeIn(layout.lanes, carriedNotGood) ? carriedNotGood.id : undefined) ??
      fallback.notGoodLane,
  };
};

/** Everything a lane layout must satisfy, as `[path, message]` pairs; empty when it is sound. */
export const laneLayoutProblems = (layout: LaneLayout): readonly (readonly [string, string])[] => {
  const problems: (readonly [string, string])[] = [];
  const ids = layout.lanes.map(lane => lane.id);
  if (new Set(ids).size !== ids.length) problems.push(['lanes', 'lane ids must be unique']);
  if (!layout.lanes.some(lane => lane.category === 'backlog')) {
    problems.push(['lanes', 'a lane set needs at least one backlog lane']);
  }
  const closed = layout.lanes.filter(lane => lane.category === 'closed');
  if (closed.length !== 1) problems.push(['lanes', 'a lane set needs exactly one closed lane']);
  const hasVerify = layout.lanes.some(lane => lane.category === 'verify');
  if (hasVerify && closed.some(lane => lane.ownerGate !== true)) {
    problems.push(['lanes', 'the closed lane is owner-gated in a set that has a verify lane']);
  }
  if (layout.lanes.some(lane => lane.category === 'verify' && laneEmphasis(lane) !== 'action')) {
    problems.push(['lanes', "a verify lane is the owner's action, so its emphasis is action"]);
  }
  if (closed.some(lane => laneEmphasis(lane) !== 'info')) {
    problems.push(['lanes', 'the closed lane is hidden information, so its emphasis is info']);
  }
  for (const [workflow, variant] of Object.entries(layout.variants)) {
    const positions = (variant ?? []).map(id => ids.indexOf(id));
    if (positions.includes(-1)) problems.push([`variants.${workflow}`, 'a variant names only lanes of this set']);
    else if (positions.some((position, index) => index > 0 && position <= (positions[index - 1] ?? -1))) {
      problems.push([`variants.${workflow}`, 'a variant lists its lanes once each, in lane order']);
    }
  }
  for (const lane of layout.lanes) {
    if (lane.stage?.kind !== 'gate') continue;
    for (const option of lane.stage.options) {
      if (option.outcome.kind !== 'lane') continue;
      if (option.outcome.laneId === lane.id) problems.push(['lanes', 'a gate option sends the card to another lane']);
      else if (!ids.includes(option.outcome.laneId)) problems.push(['lanes', 'a gate option names a lane of this set']);
    }
  }
  if (layout.doneLane !== undefined) {
    const done = layout.lanes.find(lane => lane.id === layout.doneLane);
    if (done?.category !== 'closed') problems.push(['doneLane', 'Done moves a card to the closed lane']);
  }
  if (layout.notGoodLane !== undefined) {
    const notGood = layout.lanes.find(lane => lane.id === layout.notGoodLane);
    if (notGood === undefined || !mayResumeIn(layout.lanes, notGood)) {
      problems.push(['notGoodLane', 'Not good moves a card back to an active lane, where work resumes']);
    }
  }
  return problems;
};

const refineLaneLayout = (value: LaneLayout, context: z.RefinementCtx): void => {
  for (const [path, message] of laneLayoutProblems(value)) {
    context.addIssue({ code: 'custom', message, path: path.split('.') });
  }
};

export const LaneLayoutSchema = z.object(LaneLayoutShape).superRefine(refineLaneLayout);
export type LaneLayoutValue = z.infer<typeof LaneLayoutSchema>;

/**
 * A stored set or a daemon's answer from before Done and Not good were declared reads with the targets
 * {@link defaultLaneTargets} derives, so every reader of a set has them. Anything that is not such a set
 * passes through untouched, for the schema to refuse.
 */
const withDerivedTargets = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || !('lanes' in value) || !Array.isArray(value.lanes)) return value;
  const record = value as Record<string, unknown> & { readonly lanes: readonly unknown[] };
  if (record['doneLane'] !== undefined && record['notGoodLane'] !== undefined) return value;
  const lanes = LaneSchema.array().safeParse(record.lanes);
  const derived = lanes.success ? defaultLaneTargets(lanes.data) : undefined;
  if (derived === undefined) return value;
  return {
    ...record,
    doneLane: record['doneLane'] ?? derived.doneLane,
    notGoodLane: record['notGoodLane'] ?? derived.notGoodLane,
  };
};

/**
 * A ferret's lanes WAITING FOR THE OWNER (`docs/board.md` § A ferret's lane change waits for the owner): stored
 * beside the live set and never read as the board's lanes, so no card moves and no gate changes until the owner
 * accepts it. `version` is the number the set takes when it is accepted and the key of its agenda card; it is
 * above every number the set has had, so an Accept of an older card never names it. `baseVersion` is the live
 * set it was made against: an accept once the live set moved on is a version conflict. `relocate` is where the
 * cards of the lanes it removes go, moved only when it goes live, as the owner. `proposerSession` is the session whose
 * agenda holds its card: only that session, a lead above it or the owner replaces it. Absent on a proposal stored
 * before it was recorded, which anyone may replace.
 */
export const PendingLaneSetSchema = z
  .object({
    version: PositiveIntegerSchema,
    baseVersion: PositiveIntegerSchema,
    proposedBy: z.string().min(1),
    proposerSession: z.string().min(1).optional(),
    lanes: LaneLayoutShape.lanes,
    variants: LaneLayoutShape.variants,
    ...LaneTargetsShape,
    relocate: z.partialRecord(LaneIdSchema, LaneIdSchema),
  })
  .superRefine((value, context) => {
    refineLaneLayout(value, context);
    if (value.version <= value.baseVersion) {
      context.addIssue({ code: 'custom', message: 'a proposal is numbered above its live set', path: ['version'] });
    }
  });
export type PendingLaneSet = z.infer<typeof PendingLaneSetSchema>;

/** One thing a lane change would do that is the owner's to decide: the lane it is about, and what, in words. */
export interface LaneGateProblem {
  readonly laneId: string;
  readonly why: string;
}

const isGateLane = (lane: Pick<Lane, 'category' | 'enterOn' | 'ownerGate' | 'stage'>): boolean =>
  laneStage(lane).kind === 'gate';

type Walkable = Pick<LaneSet, 'lanes' | 'variants'>;

/** The lanes a workflow walks, in the set's order (whatever order its variant names them in). */
const walk = (set: Walkable, workflow: TaskWorkflow): readonly string[] => {
  const walked = variantLanes(set, workflow);
  const named = new Set((walked.ok ? walked.value : set.lanes).map(lane => lane.id));
  return set.lanes.filter(lane => named.has(lane.id)).map(lane => lane.id);
};

/** Whether the same lanes come before `gate` in both walks, counting only the lanes both walk. */
const sameBefore = (gate: string, was: readonly string[], now: readonly string[]): boolean => {
  const both = (id: string): boolean => was.includes(id) && now.includes(id);
  const left = was.slice(0, was.indexOf(gate)).filter(both);
  const right = now.slice(0, now.indexOf(gate)).filter(both);
  return left.length === right.length && left.every(id => right.includes(id));
};

/**
 * The first gate of the NEW layout a relocation `from` → `to` would put cards past, in any variant's walk: a gate
 * that comes before `to` there, and that came after `from` before (or is new).
 */
const passedGate = (current: Walkable, next: Walkable, from: string, to: string): Lane | undefined => {
  for (const workflow of TaskWorkflowSchema.options) {
    const was = walk(current, workflow);
    const now = walk(next, workflow);
    if (!was.includes(from) || !now.includes(to)) continue;
    const passed = now
      .slice(0, now.indexOf(to))
      .map(id => next.lanes.find(lane => lane.id === id))
      .find(
        lane =>
          lane !== undefined &&
          isGateLane(lane) &&
          (!was.includes(lane.id) || was.indexOf(lane.id) > was.indexOf(from)),
      );
    if (passed !== undefined) return passed;
  }
  return undefined;
};

/** What a gate's answers do, in a form two gates can be compared by. */
const answersOf = (lane: Lane): string => JSON.stringify(gateOptions(lane).map(option => [option.id, option.outcome]));

/**
 * EVERYTHING a change from `current` to `next` would do that is the owner's to decide (`docs/board.md` § A ferret's
 * lane change waits for the owner), in the owner's words, for a waiting proposal's Accept card and the lane editor:
 *
 * - each lane it removes (saying when it is a gate) and where its cards go: into the closed lane (named by its
 *   CATEGORY, never by a name the proposal chose), into a lane that is new, or past a gate of the new layout;
 * - each gate it makes automatic, whose `ownerGate` it drops, or whose answers it rewires;
 * - each lane it makes the closed lane, which closes the cards in it;
 * - each gate a workflow would skip, or walk to from a different place.
 *
 * A lane is named as the owner knows it: by its current name. Empty when the change does none of these (a rename,
 * say). Pure and total.
 */
export const laneGateProblems = (
  current: Walkable,
  next: Walkable,
  relocate: Readonly<Partial<Record<string, string>>> = {},
): readonly LaneGateProblem[] => {
  const known = (id: string): string => current.lanes.find(lane => lane.id === id)?.name ?? id;
  const problems: LaneGateProblem[] = [];
  for (const lane of current.lanes) {
    const kept = next.lanes.find(candidate => candidate.id === lane.id);
    const gate = isGateLane(lane);
    if (kept === undefined) {
      problems.push(removal(current, next, lane, gate, relocate[lane.id], known));
      continue;
    }
    if (kept.category === 'closed' && lane.category !== 'closed') {
      problems.push({ laneId: lane.id, why: `makes ${lane.name} the closed lane, which closes the cards in it` });
    }
    if (!gate) continue;
    if (!isGateLane(kept)) {
      problems.push({ laneId: lane.id, why: `makes ${lane.name} automatic: it would stop waiting for the owner` });
    } else {
      if (lane.ownerGate === true && kept.ownerGate !== true) {
        problems.push({ laneId: lane.id, why: `drops the owner gate of ${lane.name}` });
      }
      if (answersOf(lane) !== answersOf(kept)) {
        problems.push({ laneId: lane.id, why: `changes what the answers to ${lane.name} do` });
      }
    }
    for (const workflow of TaskWorkflowSchema.options) {
      const was = walk(current, workflow);
      if (!was.includes(lane.id)) continue;
      const now = walk(next, workflow);
      if (!now.includes(lane.id)) {
        problems.push({ laneId: lane.id, why: `lets ${workflow} work skip ${lane.name}` });
      } else if (!sameBefore(lane.id, was, now)) {
        problems.push({ laneId: lane.id, why: `moves ${lane.name} among the lanes ${workflow} work walks` });
      }
    }
  }
  return problems;
};

/** A removed lane in words: what it was, and where its cards go. */
const removal = (
  current: Walkable,
  next: Walkable,
  lane: Lane,
  gate: boolean,
  to: string | undefined,
  known: (id: string) => string,
): LaneGateProblem => {
  const removed = `removes ${lane.name}${gate ? ', which waits for the owner' : ''}`;
  const target = to === undefined ? undefined : next.lanes.find(candidate => candidate.id === to);
  if (to === undefined || target === undefined) return { laneId: lane.id, why: removed };
  if (target.category === 'closed') {
    return { laneId: to, why: `${removed}, and sends its cards into the closed lane, which closes them` };
  }
  // Judged where the cards end up: the new layout. A lane that is new gives no account of what it passed.
  if (!current.lanes.some(candidate => candidate.id === to)) {
    return { laneId: to, why: `${removed}, and sends its cards into ${target.name}, a lane that is new` };
  }
  const passed = passedGate(current, next, lane.id, to);
  return passed === undefined
    ? { laneId: lane.id, why: `${removed}, and moves its cards to ${known(to)}` }
    : {
        laneId: passed.id,
        why: `${removed}, and sends its cards to ${known(to)}, past ${known(passed.id)}, which waits for the owner`,
      };
};

/**
 * A project's lanes. `version` rises with every edit, so an edit can say which set it was made against.
 * `confirmedBy` is `null` while the set is a proposal: live, but not yet accepted by the owner. `doneLane`
 * and `notGoodLane` are always there once parsed: a set from before them gets {@link defaultLaneTargets}.
 * `pending` is a ferret's change to it, waiting for the owner ({@link PendingLaneSetSchema}); an app or a
 * daemon that predates it reads the live set and drops it.
 */
export const LaneSetSchema = z.preprocess(
  withDerivedTargets,
  z
    .object({
      projectId: BoardProjectIdSchema,
      version: PositiveIntegerSchema,
      confirmedBy: z.literal('owner').nullable(),
      /** `BoardActorVia`: present when the owner's confirmation came on the admin token, never on a person's app. */
      confirmedVia: BoardActorViaSchema.optional(),
      proposedBy: z.string().min(1),
      ...LaneLayoutShape,
      ...LaneTargetsShape,
      pending: PendingLaneSetSchema.optional(),
    })
    .superRefine((value, context) => {
      refineLaneLayout(value, context);
      if (value.pending !== undefined && value.pending.version <= value.version) {
        context.addIssue({
          code: 'custom',
          message: 'a waiting proposal is numbered above the live set',
          path: ['pending', 'version'],
        });
      }
    }),
);
export type LaneSet = z.infer<typeof LaneSetSchema>;

// ---------------------------------------------------------------------------------------------------
// Templates: pure data a ferret proposes from.
// ---------------------------------------------------------------------------------------------------

export const LaneTemplateNameSchema = z.enum(['pr-release-verify', 'pr-release', 'pr', 'ops', 'writing', 'quick']);
export type LaneTemplateName = z.infer<typeof LaneTemplateNameSchema>;

const ALL_WORKFLOWS = TaskWorkflowSchema.options;
const everyWorkflow = (lanes: readonly string[]): LaneVariants =>
  Object.fromEntries(ALL_WORKFLOWS.map(workflow => [workflow, [...lanes]]));

/** The workflows whose plan the owner approves before the work starts; the others skip Plan/Design. */
const PLANNED_WORKFLOWS: ReadonlySet<TaskWorkflow> = new Set<TaskWorkflow>(['design-first', 'research-first']);

/** A template lane with its stage written out, so a stored set says what each of its lanes is. */
const staged = (lane: Lane): Lane => ({ ...lane, stage: laneStage(lane) });
const stagedLanes = (lanes: readonly Lane[]): Lane[] => lanes.map(staged);

const todo: Lane = { id: 'todo', name: 'Todo', category: 'backlog', staleAfter: '3d', emphasis: 'progress' };
const plan: Lane = {
  id: 'plan',
  name: 'Plan/Design',
  category: 'active',
  enterOn: ['work.started'],
  ownerGate: true,
  staleAfter: '2h',
  emphasis: 'action',
};
/**
 * Being worked on, PR open or not: review and CI are the ferret's to finish, not the owner's to act on, so
 * they fold in here instead of being a lane of their own. An open PR on a shipped card pulls it back here.
 */
const inProgress: Lane = {
  id: 'implement',
  name: 'In progress',
  category: 'active',
  enterOn: ['work.started', 'pr.opened', 'pr.ready'],
  staleAfter: '4h',
  emphasis: 'progress',
};
const merged: Lane = {
  id: 'merged',
  name: 'Merged',
  category: 'shipped',
  enterOn: ['pr.merged'],
  staleAfter: '3d',
  emphasis: 'info',
};
/** A release is what the owner can test, so released IS "to test": one lane, the owner's to move on. */
const releasedToTest: Lane = {
  id: 'released',
  name: 'Released · to test',
  category: 'verify',
  enterOn: ['release.published'],
  ownerGate: true,
  emphasis: 'action',
};
const closed: Lane = { id: 'closed', name: 'Closed', category: 'closed', ownerGate: true, emphasis: 'info' };

/** The PR flow, with Plan/Design walked only by the workflows that plan first. */
const prVariants = (lanes: readonly Lane[]): LaneVariants => {
  const ids = lanes.map(lane => lane.id);
  const unplanned = ids.filter(id => id !== 'plan');
  return Object.fromEntries(
    ALL_WORKFLOWS.map(workflow => [workflow, PLANNED_WORKFLOWS.has(workflow) ? [...ids] : unplanned]),
  );
};

const prReleaseVerifyLanes: Lane[] = stagedLanes([todo, plan, inProgress, merged, releasedToTest, closed]);
const prReleaseLanes: Lane[] = stagedLanes([
  todo,
  plan,
  inProgress,
  merged,
  { id: 'released', name: 'Released', category: 'closed', enterOn: ['release.published'], emphasis: 'info' },
]);
const prLanes: Lane[] = stagedLanes([
  todo,
  plan,
  inProgress,
  { id: 'merged', name: 'Merged', category: 'closed', enterOn: ['pr.merged'], emphasis: 'info' },
]);
const opsLanes: Lane[] = stagedLanes([
  todo,
  { id: 'investigate', name: 'Investigate', category: 'active', enterOn: ['work.started'], staleAfter: '2h' },
  { id: 'fix', name: 'Fix', category: 'active', staleAfter: '2h' },
  { id: 'verify', name: 'Verify', category: 'verify', enterOn: ['signal.done'], ownerGate: true, emphasis: 'action' },
  closed,
]);
const writingLanes: Lane[] = stagedLanes([
  todo,
  { id: 'research', name: 'Research', category: 'active', enterOn: ['work.started'], staleAfter: '2h' },
  { id: 'draft', name: 'Draft', category: 'active', staleAfter: '2h' },
  {
    id: 'review',
    name: 'Review',
    category: 'review',
    enterOn: ['pr.opened', 'signal.done'],
    staleAfter: '24h',
    emphasis: 'action',
  },
  { id: 'published', name: 'Published', category: 'shipped', enterOn: ['pr.merged'], staleAfter: '3d' },
  closed,
]);
/**
 * Quick work's one thing for the owner to do: try it. It has no release step, so a merge is what the owner
 * tests, and so is a ferret's done with no PR.
 */
export const QUICK_TO_TEST_LANE: Lane = staged({
  id: 'to-test',
  name: 'To test',
  category: 'verify',
  enterOn: ['pr.merged', 'release.published', 'signal.done'],
  ownerGate: true,
  emphasis: 'action',
});
const quickLanes: Lane[] = stagedLanes([
  todo,
  { id: 'doing', name: 'Doing', category: 'active', enterOn: ['work.started'], staleAfter: '2h' },
  QUICK_TO_TEST_LANE,
  closed,
]);

/** A template: a layout that names its Done and Not good lanes. */
export type LaneTemplate = LaneLayoutValue & LaneTargets;

/**
 * The templates, as data, built by the lane design rule (`docs/board.md`): a lane for each thing the owner
 * DOES, plus just enough progress to show work moves, and nothing more.
 *
 * - `pr-release-verify` — Ferretry's own: Todo → Plan/Design → In progress → Merged → Released · to test →
 *   Closed. A card reaches Released · to test when its PR ships in a release; the owner's Done closes it.
 * - `pr-release` — no testing step; Released closes.
 * - `pr` — Merged closes.
 * - `ops` — Investigate → Fix → Verify → Closed.
 * - `writing` — Research → Draft → Review → Published → Closed.
 * - `quick` — Todo → Doing → To test → Closed. A merge, a release or the ferret's done puts the card in To
 *   test; the owner's Done closes it. The Unfiled board uses it.
 *
 * In the PR templates only `design-first` and `research-first` work walks Plan/Design. Not good sends a
 * card back to the last active lane (In progress, Fix, Draft, Doing); Done sends it to the closed lane.
 */
export const LANE_TEMPLATES: Readonly<Record<LaneTemplateName, LaneTemplate>> = {
  'pr-release-verify': {
    lanes: prReleaseVerifyLanes,
    variants: prVariants(prReleaseVerifyLanes),
    doneLane: 'closed',
    notGoodLane: 'implement',
  },
  'pr-release': {
    lanes: prReleaseLanes,
    variants: prVariants(prReleaseLanes),
    doneLane: 'released',
    notGoodLane: 'implement',
  },
  pr: { lanes: prLanes, variants: prVariants(prLanes), doneLane: 'merged', notGoodLane: 'implement' },
  ops: {
    lanes: opsLanes,
    variants: everyWorkflow(opsLanes.map(lane => lane.id)),
    doneLane: 'closed',
    notGoodLane: 'fix',
  },
  writing: {
    lanes: writingLanes,
    variants: everyWorkflow(writingLanes.map(lane => lane.id)),
    doneLane: 'closed',
    notGoodLane: 'draft',
  },
  quick: {
    lanes: quickLanes,
    variants: everyWorkflow(quickLanes.map(lane => lane.id)),
    doneLane: 'closed',
    notGoodLane: 'doing',
  },
};

/** Renames a proposal applies to its template's lanes, by lane id. */
export const LaneRenamesSchema = z.partialRecord(LaneIdSchema, LaneNameSchema);
export type LaneRenames = z.infer<typeof LaneRenamesSchema>;

export type LaneTemplateError = { readonly code: 'unknown-lane'; readonly laneId: string };

/** A template's layout with the proposer's renames applied; a rename of a lane it does not have is refused. */
export const laneLayoutFromTemplate = (
  template: LaneTemplateName,
  renames: LaneRenames = {},
): BoardResult<LaneTemplate, LaneTemplateError> => {
  const layout = LANE_TEMPLATES[template];
  const unknown = Object.keys(renames).find(id => !layout.lanes.some(lane => lane.id === id));
  if (unknown !== undefined) return boardErr({ code: 'unknown-lane', laneId: unknown });
  return boardOk({
    lanes: layout.lanes.map(lane => ({ ...lane, name: renames[lane.id] ?? lane.name })),
    variants: layout.variants,
    doneLane: layout.doneLane,
    notGoodLane: layout.notGoodLane,
  });
};

// ---------------------------------------------------------------------------------------------------
// Helpers: pure and total.
// ---------------------------------------------------------------------------------------------------

export type LaneLookupError =
  | { readonly code: 'unknown-lane'; readonly laneId: string }
  | { readonly code: 'no-lane-of-category'; readonly category: LaneCategory };

type Lanes = Pick<LaneSet, 'lanes' | 'variants'>;

const laneIndex = (laneSet: Lanes, laneId: string): BoardResult<number, LaneLookupError> => {
  const index = laneSet.lanes.findIndex(lane => lane.id === laneId);
  return index === -1 ? boardErr({ code: 'unknown-lane', laneId }) : boardOk(index);
};

/** A lane, by id. */
export const laneOf = (laneSet: Lanes, laneId: string): BoardResult<Lane, LaneLookupError> => {
  const found = laneSet.lanes.find(lane => lane.id === laneId);
  return found === undefined ? boardErr({ code: 'unknown-lane', laneId }) : boardOk(found);
};

/** The category of a lane. */
export const categoryOf = (laneSet: Lanes, laneId: string): BoardResult<LaneCategory, LaneLookupError> => {
  const lane = laneOf(laneSet, laneId);
  return lane.ok ? boardOk(lane.value.category) : lane;
};

/** Whether moving from one lane to another goes back: to a lane earlier in the set's order. */
export const isBackwardMove = (laneSet: Lanes, from: string, to: string): BoardResult<boolean, LaneLookupError> => {
  const origin = laneIndex(laneSet, from);
  if (!origin.ok) return origin;
  const target = laneIndex(laneSet, to);
  return target.ok ? boardOk(target.value < origin.value) : target;
};

/** The lanes a workflow walks, in order. A workflow with no variant walks every lane. */
export const variantLanes = (laneSet: Lanes, workflow: TaskWorkflow): BoardResult<readonly Lane[], LaneLookupError> => {
  const ids = laneSet.variants[workflow];
  if (ids === undefined) return boardOk(laneSet.lanes);
  const lanes: Lane[] = [];
  for (const id of ids) {
    const lane = laneOf(laneSet, id);
    if (!lane.ok) return lane;
    lanes.push(lane.value);
  }
  return boardOk(lanes);
};

/**
 * The lane after `from` in a workflow's variant, or `null` when `from` is its last. A card sitting in a
 * lane its variant skips (after a lane edit, say) moves on to the variant's first lane later in the set.
 */
export const nextLane = (
  laneSet: Lanes,
  workflow: TaskWorkflow,
  from: string,
): BoardResult<Lane | null, LaneLookupError> => {
  const origin = laneIndex(laneSet, from);
  if (!origin.ok) return origin;
  const lanes = variantLanes(laneSet, workflow);
  if (!lanes.ok) return lanes;
  const next = lanes.value.find(lane => laneSet.lanes.indexOf(lane) > origin.value);
  return boardOk(next ?? null);
};

/** The first lane of a category a workflow walks (e.g. where a new card goes, or where work starts). */
export const firstLaneOfCategory = (
  laneSet: Lanes,
  workflow: TaskWorkflow,
  category: LaneCategory,
): BoardResult<Lane, LaneLookupError> => {
  const lanes = variantLanes(laneSet, workflow);
  if (!lanes.ok) return lanes;
  const found = lanes.value.find(lane => lane.category === category);
  return found === undefined ? boardErr({ code: 'no-lane-of-category', category }) : boardOk(found);
};

/** The lane a trigger moves a card of this workflow into, or `null` when its variant has none for it. */
export const laneForTrigger = (
  laneSet: Lanes,
  workflow: TaskWorkflow,
  trigger: LaneTrigger,
): BoardResult<Lane | null, LaneLookupError> => {
  const lanes = variantLanes(laneSet, workflow);
  if (!lanes.ok) return lanes;
  return boardOk(lanes.value.find(lane => lane.enterOn?.includes(trigger) === true) ?? null);
};

/**
 * Whether only the owner may make this move: into an owner-gated `closed` lane, or forward out of a gate
 * ({@link laneStage}: a `verify` lane is one whether or not it is owner-gated) or any other owner-gated lane.
 * A backward move never needs the owner's gate (it needs a reason).
 */
export const needsOwner = (laneSet: Lanes, from: string, to: string): BoardResult<boolean, LaneLookupError> => {
  const origin = laneOf(laneSet, from);
  if (!origin.ok) return origin;
  const target = laneOf(laneSet, to);
  if (!target.ok) return target;
  if (target.value.category === 'closed' && target.value.ownerGate === true) return boardOk(true);
  const backward = laneSet.lanes.indexOf(target.value) < laneSet.lanes.indexOf(origin.value);
  const gated = origin.value.ownerGate === true || laneStage(origin.value).kind === 'gate';
  return boardOk(!backward && origin.value.id !== target.value.id && gated);
};

export type GateOutcomeError =
  | LaneLookupError
  | { readonly code: 'not-a-gate'; readonly laneId: string }
  | { readonly code: 'unknown-option'; readonly laneId: string; readonly optionId: string }
  | { readonly code: 'no-next-lane'; readonly laneId: string };

/** The option the owner chose at a gate, and the lane it sends the card to. */
export interface GateOutcomeTarget {
  readonly option: GateOption;
  readonly lane: Lane;
}

/**
 * Where answering a lane's gate with one of its options sends a card of this workflow: the next lane of its
 * variant, a named lane, the set's `notGoodLane` (reopen with an agenda conversation) or its `doneLane`
 * (close). Refused for a lane that is not a gate, an option it does not have, and `next` from a variant's
 * last lane. Pure and total; WHO may answer is the caller's to decide.
 */
export const gateOutcomeLane = (
  laneSet: Pick<LaneSet, 'lanes' | 'variants' | 'doneLane' | 'notGoodLane'>,
  workflow: TaskWorkflow,
  laneId: string,
  optionId: string,
): BoardResult<GateOutcomeTarget, GateOutcomeError> => {
  const gate = laneOf(laneSet, laneId);
  if (!gate.ok) return gate;
  const stage = laneStage(gate.value);
  if (stage.kind !== 'gate') return boardErr({ code: 'not-a-gate', laneId });
  const option = stage.options.find(entry => entry.id === optionId);
  if (option === undefined) return boardErr({ code: 'unknown-option', laneId, optionId });
  const target = (id: string): BoardResult<GateOutcomeTarget, GateOutcomeError> => {
    const lane = laneOf(laneSet, id);
    return lane.ok ? boardOk({ option, lane: lane.value }) : lane;
  };
  switch (option.outcome.kind) {
    case 'next': {
      const next = nextLane(laneSet, workflow, laneId);
      if (!next.ok) return next;
      return next.value === null ? boardErr({ code: 'no-next-lane', laneId }) : boardOk({ option, lane: next.value });
    }
    case 'lane':
      return target(option.outcome.laneId);
    case 'reopen-with-agenda':
      return target(laneSet.notGoodLane);
    case 'close':
      return target(laneSet.doneLane);
  }
};

/** What a dependency waits for: its blocker merged (`shipped`, the default) or in a release. */
export const DependencyUntilSchema = z.enum(['shipped', 'released']);
export type DependencyUntil = z.infer<typeof DependencyUntilSchema>;

/**
 * Whether a blocker no longer blocks. Waiting for `shipped`, a blocker in a `shipped`, `verify` or `closed`
 * lane is done. Waiting for `released`, a `shipped` blocker is done only once it is in a release
 * (`released`); `verify` and `closed` are past that point already.
 */
export const isBlockerDone = (category: LaneCategory, until: DependencyUntil, released = false): boolean => {
  if (category === 'verify' || category === 'closed') return true;
  if (category !== 'shipped') return false;
  return until === 'shipped' || released;
};

// ---------------------------------------------------------------------------------------------------
// The lane-proposal card: the one agenda choice a proposal raises for the owner.
// ---------------------------------------------------------------------------------------------------

/** The option labels ARE the decision, so a client that knows nothing of lanes answers correctly by choosing. */
export const LANE_PROPOSAL_ANSWERS = { accept: 'Accept', edit: 'Edit' } as const;

const LANE_PROPOSAL_REFERENCE_PREFIX = 'lanes:';

/** The project and version a lane-proposal card is about. */
export interface LaneProposalTarget {
  readonly projectId: z.infer<typeof BoardProjectIdSchema>;
  readonly version: number;
}

/** The agenda `sourceRef` of a proposal's card, keyed by project AND version so a set proposed again gets its own. */
export const laneProposalReference = (projectId: LaneProposalTarget['projectId'], version: number): string =>
  `${LANE_PROPOSAL_REFERENCE_PREFIX}${projectId}:${String(version)}`;

/** The project and version a `sourceRef` names, or `undefined` for any other reference. */
export const parseLaneProposalReference = (sourceRef: string | null): LaneProposalTarget | undefined => {
  if (sourceRef === null || !sourceRef.startsWith(LANE_PROPOSAL_REFERENCE_PREFIX)) return undefined;
  const separator = sourceRef.lastIndexOf(':');
  const version = Number(sourceRef.slice(separator + 1));
  const projectId = sourceRef.slice(LANE_PROPOSAL_REFERENCE_PREFIX.length, separator);
  if (!Number.isSafeInteger(version) || version < 1 || projectId === '') return undefined;
  const parsed = BoardProjectIdSchema.safeParse(projectId);
  return parsed.success ? { projectId: parsed.data, version } : undefined;
};
