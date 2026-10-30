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
import { BoardProjectIdSchema, type BoardResult, boardErr, boardOk } from './board-refs.ts';
import { PositiveIntegerSchema } from './common.ts';
import { type TaskWorkflow, TaskWorkflowSchema } from './tasks.ts';

export const MAX_BOARD_LANES = 16;
export const MAX_LANE_NAME_LENGTH = 40;
export const MAX_LANE_ID_LENGTH = 32;

/** The semantics the daemon reasons over, in the order a card normally travels through them. */
export const LANE_CATEGORIES = ['backlog', 'active', 'review', 'shipped', 'verify', 'closed'] as const;
export const LaneCategorySchema = z.enum(LANE_CATEGORIES);
export type LaneCategory = z.infer<typeof LaneCategorySchema>;

/** The real signals that move a card by themselves (`board-design.md` §3.1). */
export const LaneTriggerSchema = z.enum([
  'work.started',
  'pr.opened',
  'pr.ready',
  'ci.green',
  'pr.merged',
  'release.published',
  'release.running',
  'signal.done',
]);
export type LaneTrigger = z.infer<typeof LaneTriggerSchema>;

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
 * One column.
 *
 * - `enterOn`: the triggers that move a card INTO this lane. Several lanes may name the same trigger;
 *   a card goes to the first one in its workflow's variant ({@link laneForTrigger}).
 * - `ownerGate`: only the owner passes this lane's gate. For a `closed` lane the gate is its ENTRANCE
 *   (only the owner closes); for any other lane it is the forward EXIT (only the owner, or the owner's
 *   approval, moves a card on). See {@link needsOwner}.
 * - `staleAfter`: absent means the category's default (a `verify` lane is never stale).
 */
export const LaneSchema = z.object({
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
});
export type Lane = z.infer<typeof LaneSchema>;

/** The lane ids each workflow walks, in lane order. A workflow with no entry walks every lane. */
export const LaneVariantsSchema = z.partialRecord(TaskWorkflowSchema, z.array(LaneIdSchema).min(1));
export type LaneVariants = z.infer<typeof LaneVariantsSchema>;

/** The lanes and variants, before they belong to a project: a template, or the body of an edit. */
const LaneLayoutShape = {
  lanes: z.array(LaneSchema).min(1).max(MAX_BOARD_LANES),
  variants: LaneVariantsSchema,
};

type LaneLayout = { readonly lanes: readonly Lane[]; readonly variants: LaneVariants };

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
  for (const [workflow, variant] of Object.entries(layout.variants)) {
    const positions = (variant ?? []).map(id => ids.indexOf(id));
    if (positions.includes(-1)) problems.push([`variants.${workflow}`, 'a variant names only lanes of this set']);
    else if (positions.some((position, index) => index > 0 && position <= (positions[index - 1] ?? -1))) {
      problems.push([`variants.${workflow}`, 'a variant lists its lanes once each, in lane order']);
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
 * A project's lanes. `version` rises with every edit, so an edit can say which set it was made against.
 * `confirmedBy` is `null` while the set is a proposal: live, but not yet accepted by the owner.
 */
export const LaneSetSchema = z
  .object({
    projectId: BoardProjectIdSchema,
    version: PositiveIntegerSchema,
    confirmedBy: z.literal('owner').nullable(),
    proposedBy: z.string().min(1),
    ...LaneLayoutShape,
  })
  .superRefine(refineLaneLayout);
export type LaneSet = z.infer<typeof LaneSetSchema>;

// ---------------------------------------------------------------------------------------------------
// Templates: pure data a ferret proposes from.
// ---------------------------------------------------------------------------------------------------

export const LaneTemplateNameSchema = z.enum(['pr-release-verify', 'pr-release', 'pr', 'ops', 'writing', 'quick']);
export type LaneTemplateName = z.infer<typeof LaneTemplateNameSchema>;

const ALL_WORKFLOWS = TaskWorkflowSchema.options;
const everyWorkflow = (lanes: readonly string[]): LaneVariants =>
  Object.fromEntries(ALL_WORKFLOWS.map(workflow => [workflow, [...lanes]]));

const todo: Lane = { id: 'todo', name: 'Todo', category: 'backlog', staleAfter: '3d' };
const plan: Lane = {
  id: 'plan',
  name: 'Plan/Design',
  category: 'active',
  enterOn: ['work.started'],
  ownerGate: true,
  staleAfter: '2h',
};
const implement: Lane = {
  id: 'implement',
  name: 'Implement',
  category: 'active',
  enterOn: ['work.started'],
  staleAfter: '2h',
};
const review: Lane = {
  id: 'review',
  name: 'Review/CI',
  category: 'review',
  enterOn: ['pr.opened', 'pr.ready', 'signal.done'],
  staleAfter: '24h',
};
const merged: Lane = { id: 'merged', name: 'Merged', category: 'shipped', enterOn: ['pr.merged'], staleAfter: '3d' };
const released: Lane = { id: 'released', name: 'Released', category: 'shipped', enterOn: ['release.published'] };
const tested: Lane = {
  id: 'tested',
  name: 'Manually tested',
  category: 'verify',
  enterOn: ['release.running'],
  ownerGate: true,
};
const closed: Lane = { id: 'closed', name: 'Closed', category: 'closed', ownerGate: true };

/** The PR flow with its plan step skipped for `quick` work. */
const prVariants = (lanes: readonly Lane[]): LaneVariants => {
  const ids = lanes.map(lane => lane.id);
  return { ...everyWorkflow(ids), quick: ids.filter(id => id !== 'plan') };
};

const prReleaseVerifyLanes = [todo, plan, implement, review, merged, released, tested, closed];
const prReleaseLanes: Lane[] = [
  todo,
  plan,
  implement,
  review,
  merged,
  { id: 'released', name: 'Released', category: 'closed', enterOn: ['release.published'] },
];
const prLanes: Lane[] = [
  todo,
  plan,
  implement,
  review,
  { id: 'merged', name: 'Merged', category: 'closed', enterOn: ['pr.merged'] },
];
const opsLanes: Lane[] = [
  todo,
  { id: 'investigate', name: 'Investigate', category: 'active', enterOn: ['work.started'], staleAfter: '2h' },
  { id: 'fix', name: 'Fix', category: 'active', staleAfter: '2h' },
  { id: 'verify', name: 'Verify', category: 'verify', enterOn: ['signal.done'], ownerGate: true },
  closed,
];
const writingLanes: Lane[] = [
  todo,
  { id: 'research', name: 'Research', category: 'active', enterOn: ['work.started'], staleAfter: '2h' },
  { id: 'draft', name: 'Draft', category: 'active', staleAfter: '2h' },
  { id: 'review', name: 'Review', category: 'review', enterOn: ['pr.opened', 'signal.done'], staleAfter: '24h' },
  { id: 'published', name: 'Published', category: 'shipped', enterOn: ['pr.merged'], staleAfter: '3d' },
  closed,
];
const quickLanes: Lane[] = [
  todo,
  { id: 'doing', name: 'Doing', category: 'active', enterOn: ['work.started'], staleAfter: '2h' },
  { id: 'closed', name: 'Closed', category: 'closed', enterOn: ['signal.done'] },
];

/**
 * The templates, as data (`board-design.md` §2.3):
 *
 * - `pr-release-verify` — Ferretry's own: Todo → Plan/Design → Implement → Review/CI → Merged → Released →
 *   Manually tested → Closed. The card reaches Manually tested once the release runs on this machine.
 * - `pr-release` — no Manually tested; Released closes.
 * - `pr` — Merged closes.
 * - `ops` — Investigate → Fix → Verify → Closed.
 * - `writing` — Research → Draft → Review → Published → Closed.
 * - `quick` — Todo → Doing → Closed, closing when the ferret signals done.
 *
 * In the PR templates `quick` work skips Plan/Design; every other workflow walks every lane.
 */
export const LANE_TEMPLATES: Readonly<Record<LaneTemplateName, LaneLayoutValue>> = {
  'pr-release-verify': { lanes: prReleaseVerifyLanes, variants: prVariants(prReleaseVerifyLanes) },
  'pr-release': { lanes: prReleaseLanes, variants: prVariants(prReleaseLanes) },
  pr: { lanes: prLanes, variants: prVariants(prLanes) },
  ops: { lanes: opsLanes, variants: everyWorkflow(opsLanes.map(lane => lane.id)) },
  writing: { lanes: writingLanes, variants: everyWorkflow(writingLanes.map(lane => lane.id)) },
  quick: { lanes: quickLanes, variants: everyWorkflow(quickLanes.map(lane => lane.id)) },
};

/** Renames a proposal applies to its template's lanes, by lane id. */
export const LaneRenamesSchema = z.partialRecord(LaneIdSchema, LaneNameSchema);
export type LaneRenames = z.infer<typeof LaneRenamesSchema>;

export type LaneTemplateError = { readonly code: 'unknown-lane'; readonly laneId: string };

/** A template's layout with the proposer's renames applied; a rename of a lane it does not have is refused. */
export const laneLayoutFromTemplate = (
  template: LaneTemplateName,
  renames: LaneRenames = {},
): BoardResult<LaneLayoutValue, LaneTemplateError> => {
  const layout = LANE_TEMPLATES[template];
  const unknown = Object.keys(renames).find(id => !layout.lanes.some(lane => lane.id === id));
  if (unknown !== undefined) return boardErr({ code: 'unknown-lane', laneId: unknown });
  return boardOk({
    lanes: layout.lanes.map(lane => ({ ...lane, name: renames[lane.id] ?? lane.name })),
    variants: layout.variants,
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
 * Whether only the owner may make this move: into an owner-gated `closed` lane, or forward out of an
 * owner-gated lane of any other category. A backward move never needs the owner's gate (it needs a reason).
 */
export const needsOwner = (laneSet: Lanes, from: string, to: string): BoardResult<boolean, LaneLookupError> => {
  const origin = laneOf(laneSet, from);
  if (!origin.ok) return origin;
  const target = laneOf(laneSet, to);
  if (!target.ok) return target;
  if (target.value.category === 'closed' && target.value.ownerGate === true) return boardOk(true);
  const backward = laneSet.lanes.indexOf(target.value) < laneSet.lanes.indexOf(origin.value);
  return boardOk(!backward && origin.value.id !== target.value.id && origin.value.ownerGate === true);
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
