import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { HarnessSchema } from './session.ts';

/**
 * LESSONS — what Ferretry learns from its ferrets, and the owner's verdict on each (docs/learning.md).
 *
 * Two producers fill one inbox:
 *
 * - **Passive**: a ferret whose fixed instructions include the teaching files a lesson itself with
 *   `fy lesson suggest "<rule>" --scope global|repo` (or the `lessons_suggest` tool). The daemon derives
 *   the session from the credential and attaches the evidence — the owner's latest message and the turn
 *   — itself, so a ferret cannot invent provenance.
 * - **Scan**: an explicit, estimated, cancellable read of older transcripts by a miner ferret.
 *
 * Accepting a lesson never writes anything outside the daemon's state home. APPLYING one is a separate
 * act: the daemon shows the diff and an etag, and writes only that diff, only if the file has not moved.
 */

export const LearningConfigSchema = z.object({
  enabled: z.boolean(),
  agent: z.string().min(1),
  model: z.string().optional(),
  intervalMinutes: PositiveIntegerSchema,
  batchSize: PositiveIntegerSchema,
  maxMinersPerRun: PositiveIntegerSchema,
  maxSessionsPerRun: PositiveIntegerSchema,
  minSpawnGapMinutes: NonNegativeIntegerSchema,
  /**
   * Whether a NEW ferret is instructed to file lessons (its fixed instructions carry the teaching).
   * That is all it controls; a running ferret is switched on its own (`PATCH /v1/sessions/:id/learning`).
   */
  passiveDefault: z.boolean(),
});
export type LearningConfig = z.infer<typeof LearningConfigSchema>;

export const ObservationKindSchema = z.enum([
  'correction',
  'roadblock',
  'preference',
  'recurring_task',
  'tooling_failure',
  /** A lesson a ferret filed itself; the quote is the owner's message the daemon found beside it. */
  'suggestion',
]);
export type ObservationKind = z.infer<typeof ObservationKindSchema>;

export const ObservationSourceSchema = z.enum(['human', 'teammate']);
export type ObservationSource = z.infer<typeof ObservationSourceSchema>;

/**
 * Where a lesson goes when it is applied: `global` — the fleet's global instructions component, read by
 * every ferret whose profile includes it — or `repo` — that project's AGENTS.md / CLAUDE.md.
 */
export const ProposalCategorySchema = z.enum(['global', 'repo']);
export type ProposalCategory = z.infer<typeof ProposalCategorySchema>;

/** `applied` follows `accepted`: the lesson is written into its target file. */
export const ProposalStateSchema = z.enum(['pending', 'accepted', 'applied', 'rejected']);
export type ProposalState = z.infer<typeof ProposalStateSchema>;

/** Who produced a lesson: a ferret that was instructed to learn, or an explicit scan. */
export const ProposalSourceSchema = z.enum(['passive', 'scan']);
export type ProposalSource = z.infer<typeof ProposalSourceSchema>;

export const ProposalTargetSchema = z.object({
  kind: z.enum(['global-agent-guidance', 'automation-guidance', 'global-instructions', 'repo-instructions']),
  path: z.string().min(1),
  anchor: z.string().optional(),
});
export type ProposalTarget = z.infer<typeof ProposalTargetSchema>;

export const ProposalHistoryEntrySchema = z.object({
  at: InstantSchema,
  event: z.string().min(1),
  by: z.enum(['miner', 'user', 'ferret']),
  note: z.string().optional(),
});
export type ProposalHistoryEntry = z.infer<typeof ProposalHistoryEntrySchema>;

/** Where an applied lesson was written, and when. */
export const ProposalAppliedSchema = z.object({
  at: InstantSchema,
  path: z.string().min(1),
});
export type ProposalApplied = z.infer<typeof ProposalAppliedSchema>;

export const ProposalSchema = z
  .object({
    id: z.string().min(1),
    category: ProposalCategorySchema,
    state: ProposalStateSchema,
    title: z.string().min(1),
    ruleText: z.string().min(1),
    target: ProposalTargetSchema,
    observationIds: z.array(z.string().min(1)).min(1),
    occurrences: PositiveIntegerSchema,
    crossRepoCount: PositiveIntegerSchema,
    firstSeen: InstantSchema,
    lastSeen: InstantSchema,
    identity: z.string().min(1),
    history: z.array(ProposalHistoryEntrySchema).min(1),
    source: ProposalSourceSchema,
    /** The project root a `repo` lesson belongs to: where its AGENTS.md / CLAUDE.md lives. */
    project: z.string().min(1).optional(),
    /** The type the ferret (or the miner) picked, kept when the owner changes it. */
    suggestedCategory: ProposalCategorySchema.optional(),
    /** How many times the lesson was filed, duplicates included — the strength chip ("9×"). */
    count: PositiveIntegerSchema,
    applied: ProposalAppliedSchema.optional(),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.firstSeen) > Date.parse(value.lastSeen)) {
      context.addIssue({ code: 'custom', message: 'firstSeen may not follow lastSeen', path: ['firstSeen'] });
    }
  });
export type Proposal = z.infer<typeof ProposalSchema>;

export const RunManifestSchema = z.object({
  runId: z.string().min(1),
  startedAt: InstantSchema,
  finishedAt: InstantSchema.optional(),
  sessionsScanned: NonNegativeIntegerSchema,
  sessionsWithSignal: NonNegativeIntegerSchema,
  minerSessions: z.array(z.string()),
  observationsProposed: NonNegativeIntegerSchema,
  observationsVerified: NonNegativeIntegerSchema,
  rejectedQuotes: NonNegativeIntegerSchema,
  malformedFiles: NonNegativeIntegerSchema,
  proposalsCreated: NonNegativeIntegerSchema,
  proposalsStrengthened: NonNegativeIntegerSchema,
  proposalsSuppressedByTombstone: NonNegativeIntegerSchema,
  perHarness: z.record(HarnessSchema, NonNegativeIntegerSchema),
  message: z.string().optional(),
});
export type RunManifest = z.infer<typeof RunManifestSchema>;

export const EvidenceViewSchema = z.object({
  observationId: z.string().min(1),
  sessionId: z.string().min(1),
  teammate: z.string().optional(),
  repo: z.string().min(1),
  at: InstantSchema,
  quote: z.string().min(1).max(300),
  source: ObservationSourceSchema,
  kind: ObservationKindSchema,
  /** The session's turn when the evidence was taken, when the daemon could tell. */
  turn: NonNegativeIntegerSchema.optional(),
});
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;

export const ProposalViewSchema = ProposalSchema.safeExtend({
  evidence: z.array(EvidenceViewSchema).min(1),
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;

export const LearningStatusSchema = z
  .object({
    enabled: z.boolean(),
    intervalMinutes: PositiveIntegerSchema,
    watermarkAt: InstantSchema.optional(),
    lastRunAt: InstantSchema.optional(),
    pending: z.object({
      total: NonNegativeIntegerSchema,
      strong: NonNegativeIntegerSchema,
      weak: NonNegativeIntegerSchema,
    }),
    totals: z.object({
      observations: NonNegativeIntegerSchema,
      proposals: NonNegativeIntegerSchema,
      tombstones: NonNegativeIntegerSchema,
    }),
    running: z.boolean(),
    lastRun: RunManifestSchema.optional(),
    /** The machine default for new ferrets. */
    passiveDefault: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.pending.total !== value.pending.strong + value.pending.weak) {
      context.addIssue({ code: 'custom', message: 'pending total must equal strong plus weak', path: ['pending'] });
    }
  });
export type LearningStatus = z.infer<typeof LearningStatusSchema>;

/**
 * A verdict on one lesson. `categorize` changes where it goes (Global / Repo); `reopen` puts an accepted
 * lesson back in To review. None of them writes outside the state home: that is `apply`'s job.
 */
export const LearningActionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('accept') }),
  z.strictObject({ action: z.literal('reject'), note: z.string().min(1).optional() }),
  z.strictObject({ action: z.literal('edit'), ruleText: z.string().trim().min(1) }),
  z.strictObject({ action: z.literal('categorize'), category: ProposalCategorySchema }),
  z.strictObject({ action: z.literal('reopen') }),
]);
export type LearningActionRequest = z.infer<typeof LearningActionRequestSchema>;

export const LearningRunRequestSchema = z.strictObject({
  spawn: z.boolean().default(false),
});
export type LearningRunRequest = z.infer<typeof LearningRunRequestSchema>;
export type LearningRunRequestInput = z.input<typeof LearningRunRequestSchema>;

export const LearningPatchResponseSchema = z.object({
  path: z.string().min(1),
  contents: z.string(),
});
export type LearningPatchResponse = z.infer<typeof LearningPatchResponseSchema>;

// ── Settings › Learning ──────────────────────────────────────────────────────────────────────────

/** `PATCH /v1/learning/config`: the machine default for new ferrets, written into `learning.yaml`. */
export const LearningConfigPatchSchema = z.strictObject({ passiveDefault: z.boolean() });
export type LearningConfigPatch = z.infer<typeof LearningConfigPatchSchema>;

// ── Passive learning, per ferret ─────────────────────────────────────────────────────────────────

/**
 * Whether one ferret is instructed to file lessons. `default` — set from the machine default when it
 * started; `owner` — switched by a person since.
 */
export const SessionLearningSchema = z.strictObject({
  sessionId: z.string().min(1),
  passive: z.boolean(),
  since: InstantSchema,
  setBy: z.enum(['default', 'owner']),
});
export type SessionLearning = z.infer<typeof SessionLearningSchema>;

/** `PATCH /v1/sessions/:sessionId/learning`. */
export const SessionLearningPatchSchema = z.strictObject({ passive: z.boolean() });
export type SessionLearningPatch = z.infer<typeof SessionLearningPatchSchema>;

/**
 * What switching a ferret did. A RUNNING ferret is re-instructed with a queued message that does not
 * interrupt it (`sendId`), which costs it one turn; a ferret that is not running learns it at its next
 * launch, and nothing is sent.
 */
export const SessionLearningPatchResultSchema = z.strictObject({
  learning: SessionLearningSchema,
  reinstructed: z.boolean(),
  sendId: z.string().min(1).optional(),
  note: z.string().min(1),
});
export type SessionLearningPatchResult = z.infer<typeof SessionLearningPatchResultSchema>;

// ── Apply ────────────────────────────────────────────────────────────────────────────────────────

/** `If-Match`-style token for an apply: the target file's content digest, or this for an absent file. */
export const LEARNING_ABSENT_FILE_ETAG = 'absent';

/**
 * `GET /v1/learning/proposals/:id/apply-preview`: exactly what Apply will write, and the etag that
 * pins it. `diff` is a unified diff of the target file. `capability` names the grant the write needs:
 * `fleet` (global) or `filesystem` (repo; a remote device also proves a passkey).
 */
export const LearningApplyPreviewSchema = z.strictObject({
  proposalId: z.string().min(1),
  category: ProposalCategorySchema,
  path: z.string().min(1),
  exists: z.boolean(),
  etag: z.string().min(1),
  diff: z.string().min(1),
  capability: z.enum(['fleet', 'filesystem']),
  /** What else the owner should know before writing, e.g. that no profile includes the component yet. */
  notes: z.array(z.string().min(1)),
});
export type LearningApplyPreview = z.infer<typeof LearningApplyPreviewSchema>;

/** `POST /v1/learning/proposals/:id/apply`: refused with `409 apply_conflict` if the file moved. */
export const LearningApplyRequestSchema = z.strictObject({ etag: z.string().min(1) });
export type LearningApplyRequest = z.infer<typeof LearningApplyRequestSchema>;

export const LEARNING_APPLY_CONFLICT_CODE = 'apply_conflict';

// ── Scan ─────────────────────────────────────────────────────────────────────────────────────────

/** Which ferrets a scan reads. `not-passive` (the default) is every ferret not instructed to learn. */
export const LearningScanScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('not-passive') }),
  z.strictObject({ kind: z.literal('range'), from: InstantSchema, to: InstantSchema }),
  z.strictObject({ kind: z.literal('projects'), projects: z.array(z.string().min(1)).min(1).max(100) }),
  z.strictObject({ kind: z.literal('sessions'), sessionIds: z.array(z.string().min(1)).min(1).max(500) }),
]);
export type LearningScanScope = z.infer<typeof LearningScanScopeSchema>;

/** `POST /v1/learning/scan/estimate` and `POST /v1/learning/scan`: the scope, and who reads. */
export const LearningScanRequestSchema = z.strictObject({
  scope: LearningScanScopeSchema,
  /** The login (fleet agent) the miner runs on; the machine's `learning.yaml` agent when absent. */
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
export type LearningScanRequest = z.infer<typeof LearningScanRequestSchema>;

/**
 * What a scan would cost, worked out without spending anything. `usd` is absent when the model's price
 * is not known — never a guess.
 */
export const LearningScanEstimateSchema = z.strictObject({
  sessions: NonNegativeIntegerSchema,
  sessionIds: z.array(z.string().min(1)),
  /** Ferrets in scope with no transcript to read; they are skipped. */
  skipped: NonNegativeIntegerSchema,
  tokens: NonNegativeIntegerSchema,
  usd: z.number().nonnegative().optional(),
  /** Ferrets in scope beyond one scan's limit (`learning.yaml` `maxSessionsPerRun`): scan again for them. */
  beyondLimit: NonNegativeIntegerSchema,
  miners: NonNegativeIntegerSchema,
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
});
export type LearningScanEstimate = z.infer<typeof LearningScanEstimateSchema>;

export const LearningScanStateSchema = z.enum(['running', 'finished', 'cancelled', 'failed']);
export type LearningScanState = z.infer<typeof LearningScanStateSchema>;

/** One scan's progress: `done` of `total` ferrets read, and what it added to the inbox. */
export const LearningScanProgressSchema = z.strictObject({
  runId: z.string().min(1),
  state: LearningScanStateSchema,
  total: NonNegativeIntegerSchema,
  done: NonNegativeIntegerSchema,
  startedAt: InstantSchema,
  finishedAt: InstantSchema.optional(),
  added: NonNegativeIntegerSchema,
  merged: NonNegativeIntegerSchema,
  message: z.string().optional(),
});
export type LearningScanProgress = z.infer<typeof LearningScanProgressSchema>;

/** `GET /v1/learning/scan`: the newest scan, if any. */
export const LearningScanViewSchema = z.strictObject({ scan: LearningScanProgressSchema.optional() });
export type LearningScanView = z.infer<typeof LearningScanViewSchema>;
