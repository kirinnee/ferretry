/**
 * THE PROJECT BOARD (v2): one board per project, holding the cards of every ferret that works there.
 *
 * The design and its reasons are `board-design.md` §2; `docs/board.md` will own the contract once the
 * board ships. This module is the wire and storage shape, and nothing else:
 *
 * - **A card is the only work record.** Its lane, ask, links and history live here; the question the owner
 *   is asked lives on the agenda item, which names its card (`attention.ts`), and the card only DERIVES
 *   "waiting on you" from that. Nothing is copied both ways.
 * - **Stored vs derived.** {@link BoardTaskSchema} is what the daemon writes. {@link BoardTaskViewSchema}
 *   adds what is derived at read time from session liveness, the agenda store and other cards, and is
 *   never stored. Which machines already run a card's release (`runningOn`) is the app's to work out, per
 *   paired daemon, so it is not on the wire at all.
 * - **History is append-only and gap-free**, and a move back or a reopen always says why.
 *
 * Names the v1 per-session store (`tasks.ts`) already exports carry a `Board` prefix here; U18 deletes v1
 * and drops it. The kind, title rule and workflow names are v1's own schemas, reused, because they are
 * the same facts.
 */
import { z } from 'zod';
import { AttentionIdSchema } from './attention.ts';
import {
  BoardProjectIdSchema,
  type BoardResult,
  BoardTaskIdSchema,
  boardErr,
  boardOk,
  MachineIdSchema,
  type TaskRef,
  TaskRefSchema,
} from './board-refs.ts';
import {
  DependencyUntilSchema,
  isBackwardMove,
  type LaneCategory,
  LaneIdSchema,
  type LaneLookupError,
  LaneLayoutSchema,
  LaneRenamesSchema,
  type LaneSet,
  LaneSetSchema,
  LaneTemplateNameSchema,
  LaneTriggerSchema,
} from './board-lanes.ts';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { type TaskKind, TaskKindSchema, TaskMessageSchema, TaskTitleSchema, TaskWorkflowSchema } from './tasks.ts';

export const BOARD_TASK_SCHEMA_VERSION = 1 as const;
export const MAX_BOARD_SUMMARY_LENGTH = 140;
export const MAX_BOARD_PREMISE_LENGTH = 4 * 1024;
export const MAX_BOARD_CONTEXT_LENGTH = 16 * 1024;
export const MAX_BOARD_BRIEF_LENGTH = 64 * 1024;
export const MAX_BOARD_REASON_LENGTH = 2 * 1024;
export const MAX_BOARD_NOTE_LENGTH = 2 * 1024;
export const MAX_BOARD_SOURCE_LENGTH = 2 * 1024;
export const MAX_BOARD_TERMS = 32;
export const MAX_BOARD_TERM_LENGTH = 80;
export const MAX_BOARD_TERM_MEANING_LENGTH = 400;
export const MAX_BOARD_CLARIFICATIONS = 128;
export const MAX_BOARD_DEPENDENCIES = 128;
export const MAX_BOARD_LINK_LENGTH = 512;
export const MAX_BOARD_LINKS_PER_FIELD = 64;
export const MAX_BOARD_FILES = 256;
export const MAX_BOARD_FILE_LENGTH = 1024;
export const MAX_BOARD_QUERY_LENGTH = 200;
export const MAX_BOARD_PAGE = 500;
export const DEFAULT_BOARD_PAGE = 100;

const SessionIdSchema = z.string().min(1);
const reason = z.string().trim().min(1).max(MAX_BOARD_REASON_LENGTH);
const oneLine = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .refine(value => !/[\r\n]/u.test(value), 'one line');

const TASK_KIND_ID_PREFIX: Readonly<Record<TaskKind, string>> = { bug: 'B', feature: 'F', infra: 'I', chore: 'C' };

/** The id prefix a kind's cards carry: `F` for a feature. Kind is immutable because the prefix must match. */
export const taskIdPrefix = (kind: TaskKind): string => TASK_KIND_ID_PREFIX[kind];

// ---------------------------------------------------------------------------------------------------
// Agenda references
// ---------------------------------------------------------------------------------------------------

/** An agenda item, named. Agenda ids still repeat per session, so the session is part of the name. */
export const AgendaRefSchema = z.strictObject({ sessionId: SessionIdSchema, id: AttentionIdSchema });
export type AgendaRef = z.infer<typeof AgendaRefSchema>;

/** The sigil of the `!attention` reference kind. Tasks are `&`, agenda items `!`, and the two never swap. */
export const AGENDA_REF_SIGIL = '!';

/** How an agenda item is written: `!A48`. */
export const formatAgendaRef = (ref: AgendaRef): string => `${AGENDA_REF_SIGIL}${ref.id}`;

// ---------------------------------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------------------------------

/**
 * Who did something to a card. A ferret is always a session; the owner may have acted from one (a chat)
 * or from nowhere in particular (the Board page); the daemon names the session it acted for, if any.
 */
export const BoardActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ferret'), sessionId: SessionIdSchema }),
  z.strictObject({ kind: z.literal('owner'), sessionId: SessionIdSchema.optional() }),
  z.strictObject({ kind: z.literal('daemon'), sessionId: SessionIdSchema.optional() }),
]);
export type BoardActor = z.infer<typeof BoardActorSchema>;

// ---------------------------------------------------------------------------------------------------
// Card parts
// ---------------------------------------------------------------------------------------------------

/** One more thing the owner said about the ask, verbatim. */
export const BoardClarificationSchema = z.object({
  text: z.string().min(1).max(MAX_BOARD_BRIEF_LENGTH),
  source: z.string().min(1).max(MAX_BOARD_SOURCE_LENGTH),
  at: InstantSchema,
  by: BoardActorSchema,
});
export type BoardClarification = z.infer<typeof BoardClarificationSchema>;

/** One row of a card's glossary: the work's ubiquitous language, spelled out for a newcomer. */
export const BoardTermSchema = z.strictObject({
  term: oneLine(MAX_BOARD_TERM_LENGTH).pipe(z.string().min(1)),
  meaning: z.string().trim().min(1).max(MAX_BOARD_TERM_MEANING_LENGTH),
});
export type BoardTerm = z.infer<typeof BoardTermSchema>;

export const BoardTermsSchema = z
  .array(BoardTermSchema)
  .max(MAX_BOARD_TERMS)
  .refine(
    terms => new Set(terms.map(entry => entry.term.toLowerCase())).size === terms.length,
    'each term appears once',
  );

/** The owner's override of one dependency: the card may advance although the blocker is not done. */
export const DependencyOverrideSchema = z.strictObject({ by: z.literal('owner'), reason, at: InstantSchema });
export type DependencyOverride = z.infer<typeof DependencyOverrideSchema>;

export const BoardDependencySchema = z.object({
  task: TaskRefSchema,
  until: DependencyUntilSchema,
  override: DependencyOverrideSchema.optional(),
});
export type BoardDependency = z.infer<typeof BoardDependencySchema>;

/** An outside-world blocker. Blocks by the owner or by another card are derived, never stored here. */
export const ExternalBlockSchema = z.strictObject({ on: z.literal('external'), reason, since: InstantSchema });
export type ExternalBlock = z.infer<typeof ExternalBlockSchema>;

/** A card that was abandoned or superseded. Terminal and hidden like Closed, until a reopen clears it. */
export const BoardDropSchema = z.strictObject({ reason, at: InstantSchema });
export type BoardDrop = z.infer<typeof BoardDropSchema>;

/** The release a merged PR first shipped in, from the first `v*` tag containing its merge commit. */
export const ReleasedInSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
  tag: z.string().min(1).max(MAX_BOARD_LINK_LENGTH),
  at: InstantSchema,
});
export type ReleasedIn = z.infer<typeof ReleasedInSchema>;

/** What GitHub said of a PR. `unknown` until the watcher has polled it once. */
export const PrStateSchema = z.enum(['unknown', 'open', 'closed', 'merged']);
export type PrState = z.infer<typeof PrStateSchema>;

/** The PR's CI checks, summarised: none run, some still running, all passing, or any failing. */
export const PrChecksSchema = z.enum(['none', 'pending', 'passing', 'failing']);
export type PrChecks = z.infer<typeof PrChecksSchema>;

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/u;

/** The `owner/name` and number a GitHub PR URL names, or `null` when it is not one. */
export const prUrlParts = (url: string): { readonly repo: string; readonly number: number } | null => {
  const match = PR_URL.exec(url);
  return match?.[1] === undefined ? null : { repo: match[1], number: Number(match[2]) };
};

/**
 * A linked pull request: the URL somebody linked, plus the watcher's cache of what GitHub says about it.
 * The cache is a labelled projection (`polledAt`), never edited by hand; GitHub owns the facts.
 */
export const PrLinkSchema = z
  .object({
    url: z.string().max(MAX_BOARD_LINK_LENGTH).regex(PR_URL, 'a GitHub pull request URL'),
    number: PositiveIntegerSchema,
    repo: z.string().min(1).max(MAX_BOARD_LINK_LENGTH),
    state: PrStateSchema,
    draft: z.boolean(),
    checks: PrChecksSchema,
    mergedAt: InstantSchema.nullable(),
    mergeSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    releasedIn: ReleasedInSchema.nullable(),
    polledAt: InstantSchema.nullable(),
  })
  .superRefine((value, context) => {
    const parts = prUrlParts(value.url);
    if (parts !== null && (parts.repo !== value.repo || parts.number !== value.number)) {
      context.addIssue({ code: 'custom', message: 'repo and number must be the ones the URL names', path: ['url'] });
    }
    if (value.polledAt === null && value.state !== 'unknown') {
      context.addIssue({ code: 'custom', message: 'a PR never polled has an unknown state', path: ['state'] });
    }
    const merged = value.state === 'merged';
    if (merged !== (value.mergedAt !== null) || merged !== (value.mergeSha !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'mergedAt and mergeSha are set exactly when merged',
        path: ['state'],
      });
    }
    if (value.releasedIn !== null && !merged) {
      context.addIssue({ code: 'custom', message: 'only a merged PR is in a release', path: ['releasedIn'] });
    }
  });
export type PrLink = z.infer<typeof PrLinkSchema>;

const linkValue = z.string().trim().min(1).max(MAX_BOARD_LINK_LENGTH);

export const BoardTaskLinksSchema = z.object({
  prs: z
    .array(PrLinkSchema)
    .max(MAX_BOARD_LINKS_PER_FIELD)
    .refine(prs => new Set(prs.map(pr => pr.url)).size === prs.length, 'each PR is linked once'),
  branch: linkValue.nullable(),
  commits: z.array(linkValue).max(MAX_BOARD_LINKS_PER_FIELD),
  docs: z.array(linkValue).max(MAX_BOARD_LINKS_PER_FIELD),
});
export type BoardTaskLinks = z.infer<typeof BoardTaskLinksSchema>;

export const BoardLinkFieldSchema = z.enum(['pr', 'branch', 'commit', 'doc']);
export type BoardLinkField = z.infer<typeof BoardLinkFieldSchema>;

/** The card fields an edit may change, each recorded as its own `field-edited` event. */
export const BoardEditableFieldSchema = z.enum(['title', 'summary', 'premise', 'context', 'terms', 'brief']);
export type BoardEditableField = z.infer<typeof BoardEditableFieldSchema>;

// ---------------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------------

const EventBase = {
  seq: PositiveIntegerSchema,
  at: InstantSchema,
  actor: BoardActorSchema,
};

/**
 * A lane move. `backward` is recorded by the writer, which had the lane set in hand, so the event can
 * enforce on its own that a move back says why. A daemon move is `auto` and names its trigger.
 */
const MovedEventSchema = z
  .object({
    ...EventBase,
    type: z.literal('moved'),
    from: LaneIdSchema,
    to: LaneIdSchema,
    backward: z.boolean(),
    reason: reason.nullable(),
    auto: z.literal(true).optional(),
    trigger: LaneTriggerSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.from === value.to) context.addIssue({ code: 'custom', message: 'a move changes lane', path: ['to'] });
    if (value.backward && value.reason === null) {
      context.addIssue({ code: 'custom', message: 'a backward move needs a reason', path: ['reason'] });
    }
    if ((value.auto === true) !== (value.trigger !== undefined)) {
      context.addIssue({ code: 'custom', message: 'an automatic move names its trigger', path: ['trigger'] });
    }
    if (value.auto === true && value.actor.kind !== 'daemon') {
      context.addIssue({ code: 'custom', message: 'only the daemon moves a card automatically', path: ['auto'] });
    }
  });

/**
 * The card's history. Every event names its actor; the union is closed, so an event this build does not
 * know is refused rather than half-read.
 */
export const BoardTaskEventSchema = z.discriminatedUnion('type', [
  z.object({ ...EventBase, type: z.literal('created'), laneId: LaneIdSchema }),
  MovedEventSchema,
  /** The owner's words that reopened it are ALSO appended to the card's clarifications: they are a new ask. */
  z.object({
    ...EventBase,
    type: z.literal('reopened'),
    from: LaneIdSchema,
    to: LaneIdSchema,
    reason,
    ask: TaskMessageSchema,
  }),
  z.object({ ...EventBase, type: z.literal('note'), text: z.string().trim().min(1).max(MAX_BOARD_NOTE_LENGTH) }),
  z.object({
    ...EventBase,
    type: z.literal('clarified'),
    text: z.string().min(1).max(MAX_BOARD_BRIEF_LENGTH),
    source: z.string().min(1).max(MAX_BOARD_SOURCE_LENGTH),
  }),
  z.object({ ...EventBase, type: z.literal('linked'), field: BoardLinkFieldSchema, value: linkValue }),
  z.object({
    ...EventBase,
    type: z.literal('assigned'),
    from: SessionIdSchema.nullable(),
    to: SessionIdSchema.nullable(),
  }),
  z.object({
    ...EventBase,
    type: z.literal('depended'),
    task: TaskRefSchema,
    until: DependencyUntilSchema,
    override: DependencyOverrideSchema.optional(),
  }),
  z.object({ ...EventBase, type: z.literal('undepended'), task: TaskRefSchema, reason }),
  z.object({ ...EventBase, type: z.literal('blocked'), reason }),
  z.object({ ...EventBase, type: z.literal('unblocked'), reason: reason.nullable() }),
  z.object({ ...EventBase, type: z.literal('field-edited'), field: BoardEditableFieldSchema }),
  z.object({ ...EventBase, type: z.literal('file-claimed'), path: z.string().min(1).max(MAX_BOARD_FILE_LENGTH) }),
  z.object({
    ...EventBase,
    type: z.literal('file-released'),
    path: z.string().min(1).max(MAX_BOARD_FILE_LENGTH),
    reason: reason.nullable(),
  }),
  z.object({
    ...EventBase,
    type: z.literal('ordered'),
    from: NonNegativeIntegerSchema.nullable(),
    to: NonNegativeIntegerSchema.nullable(),
  }),
  z.object({
    ...EventBase,
    type: z.literal('refiled'),
    fromProject: BoardProjectIdSchema,
    toProject: BoardProjectIdSchema,
    toLane: LaneIdSchema,
    reason: reason.nullable(),
  }),
  z.object({ ...EventBase, type: z.literal('dropped'), reason }),
  z.object({ ...EventBase, type: z.literal('migrated'), legacyRef: z.string().min(1) }),
]);
export type BoardTaskEvent = z.infer<typeof BoardTaskEventSchema>;
export type BoardTaskEventType = BoardTaskEvent['type'];

// ---------------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------------

/** Where a migrated card came from: `<session>:<old id>`. Old `&F12` references resolve through it. */
export const LegacyTaskRefSchema = z.string().regex(/^[^\s:]+:[BFIC][1-9][0-9]{0,8}$/u);

const BoardTaskShape = {
  v: z.literal(BOARD_TASK_SCHEMA_VERSION),
  id: BoardTaskIdSchema,
  machineId: MachineIdSchema,
  projectId: BoardProjectIdSchema,
  laneId: LaneIdSchema,
  kind: TaskKindSchema,
  title: TaskTitleSchema,
  /** What the card face shows: one line. Empty until the ferret knows it. */
  summary: oneLine(MAX_BOARD_SUMMARY_LENGTH),
  /** The owner's words, verbatim, and where they were said. Never paraphrased. */
  ask: TaskMessageSchema,
  clarifications: z.array(BoardClarificationSchema).max(MAX_BOARD_CLARIFICATIONS),
  /** Why this work exists: the problem or belief it rests on (markdown, short). */
  premise: z.string().max(MAX_BOARD_PREMISE_LENGTH),
  /** What a newcomer needs: prior PRs, related cards, constraints (markdown). */
  context: z.string().max(MAX_BOARD_CONTEXT_LENGTH),
  terms: BoardTermsSchema,
  /** The full description or plan (markdown); a sub-ferret's brief for a card `fy new` made. */
  brief: z.string().max(MAX_BOARD_BRIEF_LENGTH),
  /** The accountable ferret: the creator by default, the lead for a delegated card. */
  owner: SessionIdSchema,
  /** The ferret doing it now; `null` reads as the owner. */
  assignee: SessionIdSchema.nullable(),
  /** The lead's card. It may live on another project's board; roll-up follows it. */
  parent: TaskRefSchema.nullable(),
  dependsOn: z.array(BoardDependencySchema).max(MAX_BOARD_DEPENDENCIES),
  blocked: ExternalBlockSchema.nullable(),
  dropped: BoardDropSchema.nullable(),
  /** Selects the lane variant. Immutable after create. */
  workflow: TaskWorkflowSchema,
  links: BoardTaskLinksSchema,
  /** Advisory: the files the work expects to touch. */
  files: z.array(z.string().min(1).max(MAX_BOARD_FILE_LENGTH)).max(MAX_BOARD_FILES),
  order: NonNegativeIntegerSchema.nullable(),
  createdAt: InstantSchema,
  createdBy: BoardActorSchema,
  history: z.array(BoardTaskEventSchema).min(1),
  legacyRef: LegacyTaskRefSchema.optional(),
};

type BoardTaskCoherence = Pick<
  z.infer<z.ZodObject<typeof BoardTaskShape>>,
  'id' | 'machineId' | 'kind' | 'parent' | 'dependsOn' | 'files' | 'history'
>;

/** Names this card, on its own machine or with the machine spelled out. */
const namesSelf = (card: { readonly id: string; readonly machineId: string }, ref: TaskRef): boolean =>
  ref.id === card.id && (ref.machineId === undefined || ref.machineId === card.machineId);

const refKey = (ref: TaskRef): string => `${ref.machineId ?? ''}/${ref.id}`;

const refineBoardTask = (value: BoardTaskCoherence, context: z.RefinementCtx): void => {
  if (!value.id.startsWith(taskIdPrefix(value.kind))) {
    context.addIssue({ code: 'custom', message: 'task id prefix must match its kind', path: ['id'] });
  }
  if (value.parent !== null && namesSelf(value, value.parent)) {
    context.addIssue({ code: 'custom', message: 'a card is not its own parent', path: ['parent'] });
  }
  if (value.dependsOn.some(dependency => namesSelf(value, dependency.task))) {
    context.addIssue({ code: 'custom', message: 'a card does not depend on itself', path: ['dependsOn'] });
  }
  if (new Set(value.dependsOn.map(dependency => refKey(dependency.task))).size !== value.dependsOn.length) {
    context.addIssue({ code: 'custom', message: 'each dependency is listed once', path: ['dependsOn'] });
  }
  if (new Set(value.files).size !== value.files.length) {
    context.addIssue({ code: 'custom', message: 'each file is listed once', path: ['files'] });
  }
  if (value.history.some((event, index) => event.seq !== index + 1)) {
    context.addIssue({ code: 'custom', message: 'history seq runs 1, 2, 3… with no gap', path: ['history'] });
  }
  if (value.history[0]?.type !== 'created' || value.history.slice(1).some(event => event.type === 'created')) {
    context.addIssue({ code: 'custom', message: 'history opens with its one created event', path: ['history'] });
  }
};

/** A card as the daemon stores it. */
export const BoardTaskSchema = z.object(BoardTaskShape).superRefine(refineBoardTask);
export type BoardTask = z.infer<typeof BoardTaskSchema>;

// ---------------------------------------------------------------------------------------------------
// Derived at read time
// ---------------------------------------------------------------------------------------------------

/**
 * How a card is doing, derived from session liveness and the board (`board-design.md` §3.3): `active`
 * (an attributed session is working), `idle`, `stale` (idle past its lane's threshold), `waiting` (on the
 * owner, the outside world or another card — someone else's clock, so never stale) or `orphaned` (its
 * ferrets are gone with the card still in an active or review lane).
 */
export const BoardTaskActivitySchema = z.enum(['active', 'idle', 'stale', 'waiting', 'orphaned']);
export type BoardTaskActivity = z.infer<typeof BoardTaskActivitySchema>;

const categoryCounts = z.strictObject({
  backlog: NonNegativeIntegerSchema,
  active: NonNegativeIntegerSchema,
  review: NonNegativeIntegerSchema,
  shipped: NonNegativeIntegerSchema,
  verify: NonNegativeIntegerSchema,
  closed: NonNegativeIntegerSchema,
});

/** A parent card's children, summed: how many (dropped ones excluded), where they are, and how many work now. */
export const RollupSchema = z
  .object({
    children: NonNegativeIntegerSchema,
    byCategory: categoryCounts,
    active: NonNegativeIntegerSchema,
    lastTouchedAt: InstantSchema.nullable(),
  })
  .superRefine((value, context) => {
    const total = Object.values(value.byCategory).reduce((sum, count) => sum + count, 0);
    if (total !== value.children) {
      context.addIssue({ code: 'custom', message: 'byCategory sums to children', path: ['byCategory'] });
    }
    if (value.active > value.children) {
      context.addIssue({ code: 'custom', message: 'no more active children than children', path: ['active'] });
    }
  });
export type Rollup = z.infer<typeof RollupSchema>;

const BoardTaskViewShape = {
  ...BoardTaskShape,
  /** The latest real activity on the card or any descendant; `null` when there has been none. */
  lastTouchedAt: InstantSchema.nullable(),
  touchedBy: SessionIdSchema.nullable(),
  activity: BoardTaskActivitySchema,
  rollup: RollupSchema,
  /** The lane the children suggest moving to; `null` when they suggest nothing. */
  suggestedLane: LaneIdSchema.nullable(),
  /** Open, blocking agenda items raised against this card. */
  waitingOnOwner: z.array(AgendaRefSchema),
  /** Every open agenda item raised against this card, blocking or not. */
  openAsks: z.array(AgendaRefSchema),
  /** Dependencies not yet done and not overridden. */
  blockedBy: z.array(TaskRefSchema),
  /** The cards that depend on this one: the inverse index, never stored. */
  blocks: z.array(TaskRefSchema),
  /** The earliest release any merged PR of the card shipped in. */
  shippedIn: ReleasedInSchema.nullable(),
};

const agendaKey = (ref: AgendaRef): string => `${ref.sessionId}/${ref.id}`;

export const BoardTaskViewSchema = z.object(BoardTaskViewShape).superRefine((value, context) => {
  refineBoardTask(value, context);
  const open = new Set(value.openAsks.map(agendaKey));
  if (value.waitingOnOwner.some(ref => !open.has(agendaKey(ref)))) {
    context.addIssue({ code: 'custom', message: 'every blocking ask is also an open ask', path: ['waitingOnOwner'] });
  }
});
export type BoardTaskView = z.infer<typeof BoardTaskViewSchema>;

// ---------------------------------------------------------------------------------------------------
// The board query and its answer
// ---------------------------------------------------------------------------------------------------

export const BoardPrStateFilterSchema = z.enum(['none', 'draft', 'open', 'ci_red', 'merged', 'released']);
export type BoardPrStateFilter = z.infer<typeof BoardPrStateFilterSchema>;

/** The activity states, plus the views the Board's one-tap pills open. */
export const BoardActivityFilterSchema = z.enum([
  ...BoardTaskActivitySchema.options,
  'to_test',
  'waiting_on_you',
  'blocked',
]);
export type BoardActivityFilter = z.infer<typeof BoardActivityFilterSchema>;

/** Which cards: `open` (the default) excludes closed and dropped ones, which there will be thousands of. */
export const BoardStateFilterSchema = z.enum(['open', 'closed', 'dropped', 'all']);
export type BoardStateFilter = z.infer<typeof BoardStateFilterSchema>;

/**
 * Whether a card belongs in a state filter. A dropped card is only ever `dropped` (or `all`), whatever
 * lane it was dropped from; `open` is everything neither closed nor dropped.
 */
export const isInBoardState = (filter: BoardStateFilter, category: LaneCategory, dropped: boolean): boolean => {
  if (filter === 'all') return true;
  if (dropped) return filter === 'dropped';
  return filter === 'closed' ? category === 'closed' : filter === 'open' && category !== 'closed';
};

export const BoardQuerySchema = z.strictObject({
  /** One project's board; absent reads every project's. */
  project: BoardProjectIdSchema.optional(),
  /** Cards this session owns or is assigned. */
  ferret: SessionIdSchema.optional(),
  kind: TaskKindSchema.optional(),
  prState: BoardPrStateFilterSchema.optional(),
  activity: BoardActivityFilterSchema.optional(),
  state: BoardStateFilterSchema.default('open'),
  /** Free text over id, title, summary and ask. */
  query: z.string().trim().min(1).max(MAX_BOARD_QUERY_LENGTH).optional(),
  cursor: z.string().min(1).max(MAX_BOARD_LINK_LENGTH).optional(),
  limit: z.number().int().min(1).max(MAX_BOARD_PAGE).default(DEFAULT_BOARD_PAGE),
});
export type BoardQuery = z.infer<typeof BoardQuerySchema>;
export type BoardQueryInput = z.input<typeof BoardQuerySchema>;

/** The header's counts, over the whole board the query scoped (not just this page). */
export const BoardCountsSchema = z.strictObject({
  closedHidden: NonNegativeIntegerSchema,
  stale: NonNegativeIntegerSchema,
  orphaned: NonNegativeIntegerSchema,
  active: NonNegativeIntegerSchema,
  toTest: NonNegativeIntegerSchema,
  waitingOnYou: NonNegativeIntegerSchema,
});
export type BoardCounts = z.infer<typeof BoardCountsSchema>;

/**
 * A card the daemon could not read. It is set aside and reported, never fatal to the board read: `id` is
 * the card file's name, and `reason` a short summary of what failed to parse — never a path or the file's
 * contents.
 */
export const BoardQuarantinedCardSchema = z.strictObject({ id: BoardTaskIdSchema, reason });
export type BoardQuarantinedCard = z.infer<typeof BoardQuarantinedCardSchema>;

/**
 * One page of a board. Scoped to one project, it carries that project's lanes, and every card is on it;
 * across every project (`projectId: null`) there is no one lane set, so the app reads each project's.
 * `quarantined` names the cards on it that could not be read.
 */
export const BoardResponseSchema = z
  .object({
    projectId: BoardProjectIdSchema.nullable(),
    laneSet: LaneSetSchema.nullable(),
    cards: z.array(BoardTaskViewSchema),
    counts: BoardCountsSchema,
    nextCursor: z.string().min(1).nullable(),
    quarantined: z.array(BoardQuarantinedCardSchema).default([]),
  })
  .superRefine((value, context) => {
    if (value.projectId === null) {
      if (value.laneSet !== null) {
        context.addIssue({ code: 'custom', message: 'a board across projects has no lane set', path: ['laneSet'] });
      }
      return;
    }
    if (value.laneSet !== null && value.laneSet.projectId !== value.projectId) {
      context.addIssue({ code: 'custom', message: "the lane set is the project's own", path: ['laneSet'] });
    }
    if (value.cards.some(card => card.projectId !== value.projectId)) {
      context.addIssue({ code: 'custom', message: "a project's board holds its own cards", path: ['cards'] });
    }
  });
export type BoardResponse = z.infer<typeof BoardResponseSchema>;

/** One card, in full. */
export const BoardTaskResponseSchema = z.object({ task: BoardTaskViewSchema, laneSet: LaneSetSchema.nullable() });
export type BoardTaskResponse = z.infer<typeof BoardTaskResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------------

const PrUrlSchema = z.string().max(MAX_BOARD_LINK_LENGTH).regex(PR_URL, 'a GitHub pull request URL');

/**
 * A new card. Who creates it is the caller, never a field; the daemon fills the machine, the counter id,
 * the lane (the variant's first backlog lane unless one is named) and the history.
 */
export const BoardTaskCreateRequestSchema = z.strictObject({
  kind: TaskKindSchema,
  title: TaskTitleSchema,
  summary: oneLine(MAX_BOARD_SUMMARY_LENGTH).default(''),
  ask: TaskMessageSchema,
  premise: z.string().max(MAX_BOARD_PREMISE_LENGTH).default(''),
  context: z.string().max(MAX_BOARD_CONTEXT_LENGTH).default(''),
  terms: BoardTermsSchema.default([]),
  brief: z.string().max(MAX_BOARD_BRIEF_LENGTH).default(''),
  workflow: TaskWorkflowSchema.default('quick'),
  /** The board; absent means the creating session's project. */
  projectId: BoardProjectIdSchema.optional(),
  laneId: LaneIdSchema.optional(),
  parent: TaskRefSchema.nullable().default(null),
  assignee: SessionIdSchema.nullable().default(null),
  dependsOn: z
    .array(z.strictObject({ task: TaskRefSchema, until: DependencyUntilSchema.default('shipped') }))
    .max(MAX_BOARD_DEPENDENCIES)
    .default([]),
  files: z.array(z.string().min(1).max(MAX_BOARD_FILE_LENGTH)).max(MAX_BOARD_FILES).default([]),
  branch: linkValue.optional(),
  docs: z.array(linkValue).max(MAX_BOARD_LINKS_PER_FIELD).default([]),
});
export type BoardTaskCreateRequest = z.infer<typeof BoardTaskCreateRequestSchema>;
export type BoardTaskCreateRequestInput = z.input<typeof BoardTaskCreateRequestSchema>;

const editFields = {
  title: TaskTitleSchema.optional(),
  summary: oneLine(MAX_BOARD_SUMMARY_LENGTH).optional(),
  premise: z.string().max(MAX_BOARD_PREMISE_LENGTH).optional(),
  context: z.string().max(MAX_BOARD_CONTEXT_LENGTH).optional(),
  terms: BoardTermsSchema.optional(),
  brief: z.string().max(MAX_BOARD_BRIEF_LENGTH).optional(),
};

/**
 * Everything else a card can be asked to do. Who may do which is the daemon's decision (ownership and
 * lineage, `board-design.md` §2.5); a dependency override is the owner's alone, enforced there too.
 */
export const BoardTaskActionRequestSchema = z.discriminatedUnion('action', [
  /** A move back needs a reason; the schema cannot tell direction, so {@link moveReasonProblem} does. */
  z.strictObject({ action: z.literal('move'), to: LaneIdSchema, reason: reason.optional() }),
  /** Make this the card the calling session's activity is attributed to. */
  z.strictObject({ action: z.literal('focus') }),
  z.strictObject({ action: z.literal('block'), reason }),
  z.strictObject({ action: z.literal('unblock'), reason: reason.optional() }),
  z.strictObject({
    action: z.literal('depend'),
    task: TaskRefSchema,
    until: DependencyUntilSchema.default('shipped'),
    override: z.strictObject({ reason }).optional(),
  }),
  z.strictObject({ action: z.literal('undepend'), task: TaskRefSchema, reason }),
  z.strictObject({ action: z.literal('drop'), reason }),
  /** Back to a lane with the owner's words: the reason, and the ask as said (appended to clarifications). */
  z.strictObject({ action: z.literal('reopen'), to: LaneIdSchema, reason, ask: TaskMessageSchema }),
  z.strictObject({
    action: z.literal('clarify'),
    text: z.string().min(1).max(MAX_BOARD_BRIEF_LENGTH),
    source: z.string().min(1).max(MAX_BOARD_SOURCE_LENGTH),
  }),
  z
    .strictObject({
      action: z.literal('link'),
      pr: PrUrlSchema.optional(),
      branch: linkValue.optional(),
      commit: linkValue.optional(),
      doc: linkValue.optional(),
    })
    .refine(
      value => [value.pr, value.branch, value.commit, value.doc].filter(field => field !== undefined).length === 1,
      'a link names exactly one of pr, branch, commit or doc',
    ),
  z.strictObject({ action: z.literal('assign'), assignee: SessionIdSchema.nullable() }),
  z.strictObject({ action: z.literal('note'), text: z.string().trim().min(1).max(MAX_BOARD_NOTE_LENGTH) }),
  z
    .strictObject({ action: z.literal('edit'), ...editFields })
    .refine(
      value => BoardEditableFieldSchema.options.some(field => value[field] !== undefined),
      'an edit changes at least one field',
    ),
  z.strictObject({
    action: z.literal('file'),
    path: z.string().min(1).max(MAX_BOARD_FILE_LENGTH),
    release: z.literal(true).optional(),
    reason: reason.optional(),
  }),
  z.strictObject({ action: z.literal('order'), order: NonNegativeIntegerSchema.nullable() }),
  /** Move the card to another project's board; absent `laneId` means the same-category lane there. */
  z.strictObject({
    action: z.literal('refile'),
    projectId: BoardProjectIdSchema,
    laneId: LaneIdSchema.optional(),
    reason: reason.optional(),
  }),
]);
export type BoardTaskActionRequest = z.infer<typeof BoardTaskActionRequestSchema>;
export type BoardTaskActionRequestInput = z.input<typeof BoardTaskActionRequestSchema>;

/**
 * A project's lanes: propose from a template (live at once, unconfirmed), edit against the version the
 * editor saw, or confirm. An edit that removes a lane says where its cards go (`relocate`), checked
 * against the current set by {@link laneEditProblems}.
 */
export const LaneSetActionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('propose'),
    template: LaneTemplateNameSchema,
    renames: LaneRenamesSchema.default({}),
  }),
  z
    .strictObject({
      action: z.literal('edit'),
      version: PositiveIntegerSchema,
      layout: LaneLayoutSchema,
      relocate: z.partialRecord(LaneIdSchema, LaneIdSchema).default({}),
    })
    .superRefine((value, context) => {
      const kept = new Set(value.layout.lanes.map(lane => lane.id));
      for (const [from, to] of Object.entries(value.relocate)) {
        if (kept.has(from)) {
          context.addIssue({
            code: 'custom',
            message: `lane ${from} is kept, so it has no relocation`,
            path: ['relocate'],
          });
        }
        if (to !== undefined && !kept.has(to)) {
          context.addIssue({
            code: 'custom',
            message: `cards go to a lane of the new set, not ${to}`,
            path: ['relocate'],
          });
        }
      }
    }),
  z.strictObject({ action: z.literal('confirm'), version: PositiveIntegerSchema }),
]);
export type LaneSetActionRequest = z.infer<typeof LaneSetActionRequestSchema>;
export type LaneSetActionRequestInput = z.input<typeof LaneSetActionRequestSchema>;

/** Why a board request was refused. */
export const BoardErrorCodeSchema = z.enum([
  'invalid',
  'not-found',
  'forbidden',
  'reason-required',
  'owner-gate',
  'blocked-by',
  'cycle',
  'unknown-lane',
  'no-lane-set',
  'version-conflict',
]);
export type BoardErrorCode = z.infer<typeof BoardErrorCodeSchema>;

export type MoveReasonProblem =
  | LaneLookupError
  | { readonly code: 'reason-required'; readonly from: string; readonly to: string };

/**
 * Whether a move is missing the reason it needs: a move back always says why. `ok(undefined)` means the
 * move may go ahead as far as its reason is concerned.
 */
export const moveReasonProblem = (
  laneSet: Pick<LaneSet, 'lanes' | 'variants'>,
  from: string,
  to: string,
  moveReason: string | undefined,
): BoardResult<undefined, MoveReasonProblem> => {
  const backward = isBackwardMove(laneSet, from, to);
  if (!backward.ok) return backward;
  return backward.value && (moveReason === undefined || moveReason.trim() === '')
    ? boardErr({ code: 'reason-required', from, to })
    : boardOk(undefined);
};

/** The lanes an edit removes without saying where their cards go. Empty when the edit is complete. */
export const laneEditProblems = (
  current: Pick<LaneSet, 'lanes'>,
  edit: {
    readonly layout: { readonly lanes: readonly { readonly id: string }[] };
    readonly relocate: Partial<Record<string, string>>;
  },
): readonly string[] => {
  const kept = new Set(edit.layout.lanes.map(lane => lane.id));
  return current.lanes.map(lane => lane.id).filter(id => !kept.has(id) && edit.relocate[id] === undefined);
};

// ---------------------------------------------------------------------------------------------------
// The fleet feed
// ---------------------------------------------------------------------------------------------------

/**
 * The journal event a board change is published as on the fleet feed (`/v1/events`), next to the
 * agenda's `attention.changed`, so a page re-reads only the cards that moved. `board.changed` carries
 * {@link BoardChangedEventSchema}.
 */
export const BOARD_EVENT_TYPES = { changed: 'board.changed' } as const;

export const BoardChangedEventSchema = z.strictObject({
  projectId: BoardProjectIdSchema,
  taskIds: z.array(BoardTaskIdSchema).min(1),
});
export type BoardChangedEvent = z.infer<typeof BoardChangedEventSchema>;
