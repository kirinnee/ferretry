import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { HarnessSchema } from './session.ts';

export const LearningConfigSchema = z.object({
  enabled: z.boolean(),
  agent: z.string().min(1),
  model: z.string().optional(),
  intervalMinutes: PositiveIntegerSchema,
  batchSize: PositiveIntegerSchema,
  maxMinersPerRun: PositiveIntegerSchema,
  maxSessionsPerRun: PositiveIntegerSchema,
  minSpawnGapMinutes: NonNegativeIntegerSchema,
});
export type LearningConfig = z.infer<typeof LearningConfigSchema>;

export const ObservationKindSchema = z.enum([
  'correction',
  'roadblock',
  'preference',
  'recurring_task',
  'tooling_failure',
]);
export type ObservationKind = z.infer<typeof ObservationKindSchema>;

export const ObservationSourceSchema = z.enum(['human', 'teammate']);
export type ObservationSource = z.infer<typeof ObservationSourceSchema>;

/** The launch release supports only global proposals and these three states. */
export const ProposalCategorySchema = z.literal('global');
export type ProposalCategory = z.infer<typeof ProposalCategorySchema>;

export const ProposalStateSchema = z.enum(['pending', 'accepted', 'rejected']);
export type ProposalState = z.infer<typeof ProposalStateSchema>;

export const ProposalTargetSchema = z.object({
  kind: z.enum(['global-agent-guidance', 'automation-guidance']),
  path: z.string().min(1),
  anchor: z.string().optional(),
});
export type ProposalTarget = z.infer<typeof ProposalTargetSchema>;

export const ProposalHistoryEntrySchema = z.object({
  at: InstantSchema,
  event: z.string().min(1),
  by: z.enum(['miner', 'user']),
  note: z.string().optional(),
});
export type ProposalHistoryEntry = z.infer<typeof ProposalHistoryEntrySchema>;

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
  })
  .superRefine((value, context) => {
    if (value.pending.total !== value.pending.strong + value.pending.weak) {
      context.addIssue({ code: 'custom', message: 'pending total must equal strong plus weak', path: ['pending'] });
    }
  });
export type LearningStatus = z.infer<typeof LearningStatusSchema>;

export const LearningActionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('accept') }),
  z.strictObject({ action: z.literal('reject'), note: z.string().min(1).optional() }),
  z.strictObject({ action: z.literal('edit'), ruleText: z.string().trim().min(1) }),
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
