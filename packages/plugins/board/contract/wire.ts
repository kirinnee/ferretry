/**
 * Board's wire schemas, copied from today's `protocol/src/lib/{board,board-lanes,board-projects,board-refs,tasks}.ts`
 * with the words renamed (task -> card, phase -> lane, status -> progress, session -> ferret, sub-ferret -> helper)
 * and every compatibility field dropped (`legacyRef`, the `#` sigil, `BoardImport`).
 *
 * CONDENSED (honest gap): the deep, rarely read members (`history` events, `rollup`, the lane layout's
 * per-lane options, a plan line's per-kind fields) are `looseObject`s here. The port replaces each with today's strict
 * schema from rebuild-ref when it ports the code that reads it.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';

export const MAX_CARD_SUMMARY_LENGTH = 140;
export const MAX_CARD_TITLE_LENGTH = 200;
export const MAX_PROGRESS_PART_LENGTH = 8 * 1024;
export const MAX_CARD_BRIEF_LENGTH = 64 * 1024;
export const MAX_CARD_NOTE_LENGTH = 2 * 1024;
export const MAX_BOARD_PAGE = 500;
export const DEFAULT_BOARD_PAGE = 100;

// ─── ids and refs ────────────────────────────────────────────────────────────────────────────────────────────────
/** `B12`, `F412`, `I3`, `C9`: the kind's letter and a number. Shown as `&F412`. */
export const CARD_ID_PATTERN = /^[BFIC][1-9][0-9]{0,8}$/u;
export const CardIdSchema = z.string().regex(CARD_ID_PATTERN);
export type CardId = z.infer<typeof CardIdSchema>;
export const CardKindSchema = z.enum(['bug', 'feature', 'infra', 'chore']);
export type CardKind = z.infer<typeof CardKindSchema>;
export const CARD_KIND_PREFIX: Readonly<Record<CardKind, string>> = { bug: 'B', feature: 'F', infra: 'I', chore: 'C' };
export const CARD_REF_SIGIL = '&';

export const MachineIdSchema = z.string().trim().min(1).max(128);
export const CardRefSchema = z.strictObject({ machine: MachineIdSchema.optional(), id: CardIdSchema });
export type CardRef = z.infer<typeof CardRefSchema>;

export const UNFILED_PROJECT_ID = 'unfiled';
/** A board's identity: a registered project's id, or the one daemon-wide board for work with no project. */
export const BoardProjectIdSchema = z.union([z.uuid(), z.literal(UNFILED_PROJECT_ID)]);
export type BoardProjectId = z.infer<typeof BoardProjectIdSchema>;

export const WorkflowSchema = z.enum(['quick', 'design-first', 'research-first', 'investigate']);
export type Workflow = z.infer<typeof WorkflowSchema>;

// ─── lanes ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const LaneIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/u, 'a lane id is lowercase letters, digits and dashes')
  .max(32);
export type LaneId = z.infer<typeof LaneIdSchema>;
export const LANE_CATEGORIES = ['backlog', 'active', 'review', 'shipped', 'verify', 'closed'] as const;
export const LaneCategorySchema = z.enum(LANE_CATEGORIES);
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
/** The triggers somebody reports rather than the daemon observing. */
export const EXTERNAL_LANE_TRIGGERS = ['pr.review_approved', 'deploy.done'] as const;
export const ExternalLaneTriggerSchema = z.enum(EXTERNAL_LANE_TRIGGERS);
export const DependencyUntilSchema = z.enum(['shipped', 'released']);

export const LaneSchema = z.looseObject({
  id: LaneIdSchema,
  name: z.string().trim().min(1).max(40),
  category: LaneCategorySchema,
});
export type Lane = z.infer<typeof LaneSchema>;
export const LaneLayoutSchema = z.looseObject({ lanes: z.array(LaneSchema).min(1).max(16) });
export const LaneTemplateNameSchema = z.enum(['pr-release-verify', 'pr-release', 'pr', 'ops', 'writing', 'quick']);
export const LaneRenamesSchema = z.partialRecord(LaneIdSchema, z.string().trim().min(1).max(40));

export const LaneSetSchema = z.looseObject({
  projectId: BoardProjectIdSchema,
  version: z.number().int().positive(),
  confirmedBy: z.literal('owner').nullable(),
  proposedBy: z.string().min(1),
  lanes: z.array(LaneSchema).min(1).max(16),
  doneLane: LaneIdSchema,
  notGoodLane: LaneIdSchema,
  pending: z.looseObject({ version: z.number().int().positive() }).optional(),
});
export type LaneSet = z.infer<typeof LaneSetSchema>;

/** `POST /v1/board/projects/:projectId/lanes`. Edits wait for the owner's confirmation: the owner's gate is on the lanes. */
export const LaneSetActionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('propose'),
    template: LaneTemplateNameSchema,
    renames: LaneRenamesSchema.default({}),
  }),
  z.strictObject({
    action: z.literal('edit'),
    version: z.number().int().positive(),
    layout: LaneLayoutSchema,
    relocate: z.partialRecord(LaneIdSchema, LaneIdSchema).default({}),
  }),
  z.strictObject({ action: z.literal('confirm'), version: z.number().int().positive() }),
]);
export type LaneSetActionRequest = z.infer<typeof LaneSetActionRequestSchema>;
/** `agenda` is whether the owner's confirmation was put on the agenda (an ask), not a Board answer. */
export const LaneSetChangeResponseSchema = z.strictObject({
  laneSet: LaneSetSchema,
  ask: z.enum(['raised', 'not-needed', 'failed']),
});

// ─── projects and the board switch ───────────────────────────────────────────────────────────────────────────────
export const BoardProjectSchema = z.strictObject({
  id: BoardProjectIdSchema,
  name: z.string().min(1),
  /** The registered folder; `null` for the Unfiled board. */
  path: z.string().min(1).nullable(),
  laneSet: LaneSetSchema.nullable(),
});
export const BoardProjectsResponseSchema = z.strictObject({
  projects: z.array(BoardProjectSchema).min(1),
  /** The board the calling ferret works on; `null` for a caller that is not a ferret. */
  current: BoardProjectIdSchema.nullable(),
});
/** Whether a project uses the board at all. Read by anybody, switched by the owner. */
export const BoardSwitchSchema = z.strictObject({
  projectId: BoardProjectIdSchema,
  on: z.boolean(),
  setBy: z.enum(['default', 'owner']),
  setAt: InstantSchema.nullable(),
});
export const BoardSwitchRequestSchema = z.strictObject({ on: z.boolean() });
/** The words a ferret is refused with: the owner decides whether a project uses the board. */
export const BOARD_SWITCH_OWNER_ONLY =
  'Only the owner switches a board on or off. Ask them first, as one agenda yes/no: "Track this on the board?"';

// ─── a card ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** A card's progress: now, done so far, next, kept current by the ferret that holds the card. A part with nothing to say is ''. */
export const ProgressSchema = z.strictObject({
  now: z.string().max(MAX_PROGRESS_PART_LENGTH),
  doneSoFar: z.string().max(MAX_PROGRESS_PART_LENGTH),
  next: z.string().max(MAX_PROGRESS_PART_LENGTH),
});
export type Progress = z.infer<typeof ProgressSchema>;
export const PROGRESS_PARTS = [
  { key: 'now', label: 'Now' },
  { key: 'doneSoFar', label: 'Done so far' },
  { key: 'next', label: 'Next' },
] as const satisfies readonly { readonly key: keyof Progress; readonly label: string }[];

export const CardActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('owner'), via: z.literal('admin-token').optional() }),
  z.strictObject({ kind: z.literal('ferret'), name: z.string().min(1), ferret: FerretIdSchema }),
  z.strictObject({ kind: z.literal('daemon') }),
]);
export type CardActor = z.infer<typeof CardActorSchema>;

export const CardDependencySchema = z.looseObject({ task: CardRefSchema, until: DependencyUntilSchema });
export const PrStateSchema = z.enum(['unknown', 'open', 'closed', 'merged']);
export const CardLinksSchema = z.looseObject({});
export const CardVisibilitySchema = z.enum(['public', 'private']);
export const CardEventSchema = z.looseObject({
  seq: z.number().int().positive(),
  type: z.string().min(1),
  at: InstantSchema,
});

/** `state/board/cards/<id>.json`. */
export const CARD_FORMAT = 1;
export const CardSchema = z.strictObject({
  format: z.literal(CARD_FORMAT),
  id: CardIdSchema,
  machine: MachineIdSchema,
  project: BoardProjectIdSchema,
  lane: LaneIdSchema,
  kind: CardKindSchema,
  title: z.string().trim().min(1).max(MAX_CARD_TITLE_LENGTH),
  summary: z.string().max(MAX_CARD_SUMMARY_LENGTH),
  ask: z.string().min(1).max(MAX_CARD_BRIEF_LENGTH),
  clarifications: z.array(z.looseObject({})),
  premise: z.string(),
  context: z.string(),
  terms: z.array(z.looseObject({})),
  brief: z.string().max(MAX_CARD_BRIEF_LENGTH),
  howToTest: z.string().default(''),
  progress: ProgressSchema.optional(),
  owner: FerretIdSchema,
  assignee: FerretIdSchema.nullable(),
  parent: CardRefSchema.nullable(),
  dependsOn: z.array(CardDependencySchema),
  blocked: z.looseObject({ on: z.literal('external'), reason: z.string(), since: InstantSchema }).nullable(),
  dropped: z.strictObject({ reason: z.string(), at: InstantSchema }).nullable(),
  workflow: WorkflowSchema,
  links: CardLinksSchema,
  files: z.array(z.string().min(1)),
  order: z.number().int().nonnegative().nullable(),
  snoozed: z.strictObject({ until: InstantSchema, lane: LaneIdSchema }).nullable().optional(),
  createdAt: InstantSchema,
  createdBy: CardActorSchema,
  history: z.array(CardEventSchema).min(1),
  askedBy: z.enum(['person', 'agent']).optional(),
  visibility: CardVisibilitySchema.optional(),
  visibilitySource: z.enum(['default', 'chosen']).optional(),
  /** The ask that approved this card's creation (the obligation is the Asks source `card`). */
  approval: z.strictObject({ ferret: FerretIdSchema, ask: z.string().min(1) }).optional(),
});
export type Card = z.infer<typeof CardSchema>;

export const CardActivitySchema = z.enum(['active', 'idle', 'stale', 'waiting', 'orphaned']);
/** A card as the board and the app read it: the stored card plus what the daemon derives. */
export const CardViewSchema = CardSchema.extend({
  activity: CardActivitySchema,
  origin: z.enum(['human', 'agent']),
  rollup: z.looseObject({}).optional(),
});
export type CardView = z.infer<typeof CardViewSchema>;

// ─── reading the board ───────────────────────────────────────────────────────────────────────────────────────────
export const BoardQuerySchema = z.strictObject({
  project: BoardProjectIdSchema.optional(),
  ferret: FerretIdSchema.optional(),
  kind: CardKindSchema.optional(),
  prState: z.enum(['none', 'draft', 'open', 'ci_red', 'merged', 'released']).optional(),
  activity: z.enum([...CardActivitySchema.options, 'to_test', 'waiting_on_you', 'blocked']).optional(),
  state: z.enum(['open', 'closed', 'dropped', 'all']).default('open'),
  visibility: z.enum(['public', 'private', 'all']).optional(),
  query: z.string().trim().min(1).max(512).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(MAX_BOARD_PAGE).default(DEFAULT_BOARD_PAGE),
});
export type BoardQuery = z.infer<typeof BoardQuerySchema>;
export const BoardCountsSchema = z.strictObject({
  closedHidden: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  orphaned: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  toTest: z.number().int().nonnegative().optional(),
  waitingOnYou: z.number().int().nonnegative().optional(),
});
export const BoardResponseSchema = z.strictObject({
  project: BoardProjectIdSchema.nullable(),
  laneSet: LaneSetSchema.nullable(),
  cards: z.array(CardViewSchema),
  counts: BoardCountsSchema,
  nextCursor: z.string().min(1).nullable(),
  quarantined: z.array(z.strictObject({ id: CardIdSchema, reason: z.string() })).default([]),
});
export const CardResponseSchema = z.strictObject({ card: CardViewSchema, laneSet: LaneSetSchema.nullable() });
export const CardStartResponseSchema = z.strictObject({
  card: CardIdSchema,
  ferret: FerretIdSchema,
  started: z.boolean(),
});
export const BoardIdsResponseSchema = z.strictObject({ ids: z.array(CardIdSchema) });
export const MergeGateResponseSchema = z.strictObject({
  pr: z.string().max(512),
  unit: z.array(CardRefSchema),
  waits: z.array(z.strictObject({ card: CardRefSchema, on: CardRefSchema, until: DependencyUntilSchema })),
  unreadable: z.array(CardIdSchema),
});
export const BoardSkipRequestSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(2 * 1024),
});
export const BoardSkipResponseSchema = z.strictObject({
  ferret: FerretIdSchema,
  skip: z.strictObject({ reason: z.string(), at: InstantSchema }),
});

// ─── changing a card ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * `POST /v1/board/cards`. NOTE (#1552): nothing on a card asks. A card made "on the owner's yes" names the ask that
 * carried that yes (`approval`); an answer to anything about a card goes through Asks, which moves the card.
 */
export const CardCreateRequestSchema = z.strictObject({
  kind: CardKindSchema,
  title: z.string().trim().min(1).max(MAX_CARD_TITLE_LENGTH),
  summary: z.string().max(MAX_CARD_SUMMARY_LENGTH).default(''),
  ask: z.string().min(1).max(MAX_CARD_BRIEF_LENGTH),
  premise: z.string().default(''),
  context: z.string().default(''),
  terms: z.array(z.looseObject({})).default([]),
  brief: z.string().max(MAX_CARD_BRIEF_LENGTH).default(''),
  howToTest: z.string().default(''),
  progress: ProgressSchema.optional(),
  workflow: WorkflowSchema.default('quick'),
  project: BoardProjectIdSchema.optional(),
  lane: LaneIdSchema.optional(),
  parent: CardRefSchema.nullable().default(null),
  assignee: FerretIdSchema.nullable().default(null),
  dependsOn: z
    .array(z.strictObject({ task: CardRefSchema, until: DependencyUntilSchema.default('shipped') }))
    .default([]),
  files: z.array(z.string().min(1)).default([]),
  branch: z.string().min(1).max(512).optional(),
  docs: z.array(z.string().min(1).max(512)).default([]),
  approval: z.string().min(1).optional(),
  visibility: CardVisibilitySchema.optional(),
});
export type CardCreateRequest = z.infer<typeof CardCreateRequestSchema>;

const reason = z.string().trim().min(1).max(MAX_CARD_NOTE_LENGTH);
/** `POST /v1/board/cards/:cardId`. One route, one discriminated union, as today. There is no `answer` action: a card never asks. */
export const CardActionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('move'), to: LaneIdSchema, reason: reason.optional() }),
  z.strictObject({ action: z.literal('trigger'), event: ExternalLaneTriggerSchema, reason: reason.optional() }),
  z.strictObject({ action: z.literal('focus') }),
  z.strictObject({ action: z.literal('block'), reason }),
  z.strictObject({ action: z.literal('unblock'), reason: reason.optional() }),
  z.strictObject({
    action: z.literal('depend'),
    task: CardRefSchema,
    until: DependencyUntilSchema.default('shipped'),
    override: z.strictObject({ reason }).optional(),
  }),
  z.strictObject({ action: z.literal('undepend'), task: CardRefSchema, reason }),
  z.strictObject({ action: z.literal('drop'), reason }),
  z.strictObject({
    action: z.literal('reopen'),
    to: LaneIdSchema,
    reason,
    ask: z.string().min(1).max(MAX_CARD_BRIEF_LENGTH),
  }),
  z.strictObject({
    action: z.literal('clarify'),
    text: z.string().min(1).max(MAX_CARD_BRIEF_LENGTH),
    source: z.string().min(1).max(256),
  }),
  z
    .strictObject({
      action: z.literal('link'),
      pr: z.string().max(512).optional(),
      branch: z.string().min(1).max(512).optional(),
      commit: z.string().min(1).max(512).optional(),
      doc: z.string().min(1).max(512).optional(),
    })
    .refine(
      value => [value.pr, value.branch, value.commit, value.doc].filter(field => field !== undefined).length === 1,
      'a link names exactly one of pr, branch, commit or doc',
    ),
  z.strictObject({ action: z.literal('assign'), assignee: FerretIdSchema.nullable() }),
  z.strictObject({ action: z.literal('claim') }),
  z.strictObject({ action: z.literal('adopt'), reason: reason.optional() }),
  z.strictObject({ action: z.literal('note'), text: z.string().trim().min(1).max(MAX_CARD_NOTE_LENGTH) }),
  z.strictObject({
    action: z.literal('edit'),
    title: z.string().trim().min(1).max(MAX_CARD_TITLE_LENGTH).optional(),
    summary: z.string().max(MAX_CARD_SUMMARY_LENGTH).optional(),
    premise: z.string().optional(),
    context: z.string().optional(),
    terms: z.array(z.looseObject({})).optional(),
    brief: z.string().max(MAX_CARD_BRIEF_LENGTH).optional(),
    howToTest: z.string().optional(),
    /** `fy card progress`: the parts it replaces; the daemon merges them in the card's own write. */
    progress: ProgressSchema.partial().optional(),
    revision: z.number().int().positive().optional(),
    visibility: CardVisibilitySchema.optional(),
  }),
  z.strictObject({
    action: z.literal('file'),
    path: z.string().min(1).max(1024),
    release: z.literal(true).optional(),
    reason: reason.optional(),
  }),
  z.strictObject({ action: z.literal('order'), order: z.number().int().nonnegative().nullable() }),
  z.strictObject({ action: z.literal('visibility'), visibility: CardVisibilitySchema, reason: reason.optional() }),
  z.strictObject({ action: z.literal('snooze'), until: InstantSchema.nullable() }),
  z.strictObject({ action: z.literal('reparent'), parent: CardRefSchema.nullable(), reason: reason.optional() }),
  z.strictObject({
    action: z.literal('refile'),
    project: BoardProjectIdSchema,
    lane: LaneIdSchema.optional(),
    reason: reason.optional(),
  }),
]);
export type CardActionRequest = z.infer<typeof CardActionRequestSchema>;

export const BoardErrorCodeSchema = z.enum([
  'invalid',
  'not-found',
  'forbidden',
  'conflict',
  'stale',
  'board-off',
  'owner-only',
  'version-conflict',
  'unknown-lane',
]);

/** The wake-up the board publishes after a write: which cards moved on which board. */
export const BoardChangedSchema = z.strictObject({
  project: BoardProjectIdSchema,
  cards: z.array(CardIdSchema).min(1),
});

// ─── the Asks source `card` ──────────────────────────────────────────────────────────────────────────────────────
/**
 * The obligation envelope a card puts on the agenda (`{ source, ref, entry }`, #1552): `ref` is the card, `entry` the
 * gate entry (a card's entry into a gate lane, with its own id). The Agenda shows it as ONE answer row; the card is
 * read-only status and is named at most once, as a plain reference. Answering moves the card (Asks -> `asks.answered`).
 */
export const CardAskRefSchema = z.strictObject({
  card: CardIdSchema,
  lane: LaneIdSchema.optional(),
  entry: z.string().min(1).optional(),
});
export type CardAskRef = z.infer<typeof CardAskRefSchema>;

// ─── plans (the `card_plan` tool) ────────────────────────────────────────────────────────────────────────────────
/** A plan a ferret asks the owner to pre-approve once: sign-ins and pastes on one card. Lines are Accounts' kinds. */
export const PlanLineSchema = z.looseObject({
  kind: z.enum(['sign-in', 'terminal-sign-in', 'paste']),
  why: z.string().min(1),
});
export const PlanSchema = z.strictObject({
  id: z.string().min(1),
  ferret: FerretIdSchema,
  lines: z.array(PlanLineSchema).min(1),
  createdAt: InstantSchema,
  expiresAt: InstantSchema,
});
export const PlanListSchema = z.strictObject({ plans: z.array(PlanSchema) });
export const PlanToolInputSchema = z.strictObject({
  lines: z.array(PlanLineSchema).min(1),
  expiresInSeconds: z.number().int().positive().optional(),
});
export const PlanApprovalRequestSchema = z.strictObject({
  lines: z.array(z.strictObject({ line: z.number().int().nonnegative() })),
});

// ─── stored files ────────────────────────────────────────────────────────────────────────────────────────────────
export const CountersFileSchema = z.strictObject({
  format: z.literal(1),
  next: z.strictObject({
    bug: z.number().int().positive(),
    feature: z.number().int().positive(),
    infra: z.number().int().positive(),
    chore: z.number().int().positive(),
  }),
});
export const BoardFileSchema = z.strictObject({
  format: z.literal(1),
  project: BoardProjectIdSchema,
  switch: BoardSwitchSchema,
  laneSet: LaneSetSchema.nullable(),
});
export const SweepFileSchema = z.strictObject({ format: z.literal(1), lastRunAt: InstantSchema.nullable() });
export const GithubFileSchema = z.strictObject({
  format: z.literal(1),
  prs: z.record(z.string(), z.looseObject({ state: PrStateSchema, checkedAt: InstantSchema })),
});

/** `config/board.yaml`: the GitHub watch. Nothing here widens authority or spend. */
export const BoardConfigSchema = z.strictObject({
  github: z
    .strictObject({ watch: z.boolean().default(true), pollSeconds: z.number().int().min(15).default(60) })
    .default({ watch: true, pollSeconds: 60 }),
});
export type BoardConfig = z.infer<typeof BoardConfigSchema>;

export type BoardSwitch = z.infer<typeof BoardSwitchSchema>;
