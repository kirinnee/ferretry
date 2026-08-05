import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { AccountAvailabilitySchema, AccountUnavailableReasonSchema, SessionStatusSchema } from './session.ts';

export const HealthViewSchema = z.object({
  ok: z.boolean(),
  bootstrapping: z.boolean(),
  bootstrapState: z.enum(['running', 'degraded', 'complete']),
  bootstrapDegraded: z.boolean(),
  version: z.string().min(1),
  pid: PositiveIntegerSchema,
  sessions: NonNegativeIntegerSchema,
  running: NonNegativeIntegerSchema,
  monitors: NonNegativeIntegerSchema,
  unmonitoredRunning: NonNegativeIntegerSchema,
  wardenLastSweepSeconds: NonNegativeIntegerSchema.nullable(),
  wardenTimerArmed: z.boolean(),
  eventLoopLagMs: NonNegativeFiniteSchema,
  lastSelfCheckAt: InstantSchema.nullable(),
  wedgeCount: NonNegativeIntegerSchema,
  scratchGcEnabled: z.boolean(),
  scratchReclaimedSessions: NonNegativeIntegerSchema,
  scratchReclaimedBytes: NonNegativeIntegerSchema,
  bootstrapErrors: NonNegativeIntegerSchema,
  bootstrapErrorMessages: z.array(z.string()).optional(),
  time: InstantSchema,
});
export type HealthView = z.infer<typeof HealthViewSchema>;

export const CgroupLimitSchema = z.object({
  cpuPercent: z.number().finite().gt(0).max(100),
  memoryPercent: z.number().finite().gt(0).max(100),
});
export type CgroupLimit = z.infer<typeof CgroupLimitSchema>;

export const CgroupConfigSchema = z
  .object({
    enabled: z.boolean(),
    fleet: CgroupLimitSchema,
    perAgent: CgroupLimitSchema,
  })
  .superRefine((value, context) => {
    if (value.perAgent.cpuPercent > value.fleet.cpuPercent) {
      context.addIssue({
        code: 'custom',
        message: 'perAgent.cpuPercent may not exceed fleet.cpuPercent',
        path: ['perAgent', 'cpuPercent'],
      });
    }
    if (value.perAgent.memoryPercent > value.fleet.memoryPercent) {
      context.addIssue({
        code: 'custom',
        message: 'perAgent.memoryPercent may not exceed fleet.memoryPercent',
        path: ['perAgent', 'memoryPercent'],
      });
    }
  });
export type CgroupConfig = z.infer<typeof CgroupConfigSchema>;

export const CgroupConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  fleet: CgroupLimitSchema.partial().optional(),
  perAgent: CgroupLimitSchema.partial().optional(),
});
export type CgroupConfigPatch = z.infer<typeof CgroupConfigPatchSchema>;

export const CgroupConfigViewSchema = z.object({
  config: CgroupConfigSchema,
  supported: z.boolean(),
  fleetSlice: z.string().min(1),
  effective: z.object({
    cpus: PositiveIntegerSchema,
    memoryBytes: PositiveIntegerSchema,
    fleet: z.object({ cpuQuota: z.string().min(1), memoryMax: z.string().min(1) }),
    perAgent: z.object({ cpuQuota: z.string().min(1), memoryMax: z.string().min(1) }),
  }),
  restartRequiredSessions: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type CgroupConfigView = z.infer<typeof CgroupConfigViewSchema>;

export const PwaConfigSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(64).optional(),
  icon: z
    .string()
    .regex(/^[A-Z0-9]{1,2}$/u)
    .optional(),
});
export type PwaConfig = z.infer<typeof PwaConfigSchema>;

const PwaNamePatchSchema = z
  .string()
  .transform(value => value.trim().replace(/\s+/gu, ' '))
  .pipe(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\p{Cc}\p{Cf}]*$/u),
  );

const PwaIconPatchSchema = z
  .string()
  .trim()
  .transform(value => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{1,2}$/u));

export const PwaConfigPatchSchema = z
  .strictObject({
    name: PwaNamePatchSchema.nullable().optional(),
    icon: PwaIconPatchSchema.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.name === undefined && value.icon === undefined) {
      context.addIssue({ code: 'custom', message: 'name or icon is required' });
    }
  });
export type PwaConfigPatch = z.infer<typeof PwaConfigPatchSchema>;

export const PwaConfigViewSchema = z.object({ config: PwaConfigSchema });
export type PwaConfigView = z.infer<typeof PwaConfigViewSchema>;

export const WardenFailoverPolicySchema = z.enum(['fallback', 'round_robin']);
export type WardenFailoverPolicy = z.infer<typeof WardenFailoverPolicySchema>;

export const WardenAccountSchema = z.object({
  agent: z.string().min(1),
  model: z.string().optional(),
});
export type WardenAccount = z.infer<typeof WardenAccountSchema>;

export const WardenFailoverConfigSchema = z.object({
  policy: WardenFailoverPolicySchema,
  failureThreshold: PositiveIntegerSchema,
  cooldownMinutes: PositiveIntegerSchema,
});
export type WardenFailoverConfig = z.infer<typeof WardenFailoverConfigSchema>;

export const ProviderOutageConfigSchema = z.object({
  minDistinctSessions: z.number().int().min(2),
  persistenceSweeps: z.number().int().min(2),
  tailLines: PositiveIntegerSchema,
});
export type ProviderOutageConfig = z.infer<typeof ProviderOutageConfigSchema>;

export const WardenConfigSchema = z.object({
  enabled: z.boolean(),
  accounts: z.array(WardenAccountSchema).min(1),
  failover: WardenFailoverConfigSchema,
  providerOutage: ProviderOutageConfigSchema,
  intervalMinutes: PositiveIntegerSchema,
  unattendedMinutes: PositiveIntegerSchema,
  minSpawnGapMinutes: NonNegativeIntegerSchema,
  susThinkingSeconds: PositiveIntegerSchema,
  susSubprocessSeconds: PositiveIntegerSchema,
  maxAssignedWardens: PositiveIntegerSchema,
  assignedCooldownMinutes: NonNegativeIntegerSchema,
  blessMinutes: NonNegativeIntegerSchema,
});
export type WardenConfig = z.infer<typeof WardenConfigSchema>;

export const WardenConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  accounts: z.array(WardenAccountSchema).min(1).optional(),
  failover: WardenFailoverConfigSchema.partial().optional(),
  providerOutage: ProviderOutageConfigSchema.partial().optional(),
  intervalMinutes: PositiveIntegerSchema.optional(),
  unattendedMinutes: PositiveIntegerSchema.optional(),
  minSpawnGapMinutes: NonNegativeIntegerSchema.optional(),
  susThinkingSeconds: PositiveIntegerSchema.optional(),
  susSubprocessSeconds: PositiveIntegerSchema.optional(),
  maxAssignedWardens: PositiveIntegerSchema.optional(),
  assignedCooldownMinutes: NonNegativeIntegerSchema.optional(),
  blessMinutes: NonNegativeIntegerSchema.optional(),
});
export type WardenConfigPatch = z.infer<typeof WardenConfigPatchSchema>;

export const WardenAnomalyKindSchema = z.enum([
  'dead_monitor',
  'unattended_question',
  'abandoned_wreckage',
  'quota_reset_passed',
  'declared_wait_overdue',
  'peer_wait_unanswerable',
  'sus_thinking',
  'sus_subprocess',
  'bootstrap_degraded',
  'provider_unavailable',
]);
export type WardenAnomalyKind = z.infer<typeof WardenAnomalyKindSchema>;

export const LivenessLedgerSchema = z.object({
  lastTranscriptAt: InstantSchema.optional(),
  lastCounterAdvanceAt: InstantSchema.optional(),
  lastTokenAdvanceAt: InstantSchema.optional(),
  lastSubprocessAt: InstantSchema.optional(),
  lastPaneChangeAt: InstantSchema.optional(),
  subprocessSince: InstantSchema.optional(),
});
export type LivenessLedger = z.infer<typeof LivenessLedgerSchema>;

export const WardenAnomalySchema = z.object({
  kind: WardenAnomalyKindSchema,
  sessionId: z.string().min(1),
  fleetKey: z.string().optional(),
  generation: NonNegativeIntegerSchema.optional(),
  provider: z.string().optional(),
  affectedSessionIds: z.array(z.string()).optional(),
  failureClasses: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  teammate: z.string().optional(),
  label: z.string().optional(),
  status: SessionStatusSchema,
  detail: z.string().min(1),
  since: InstantSchema.optional(),
  idleMinutes: NonNegativeFiniteSchema.optional(),
  assignedWarden: z.boolean().optional(),
  ledger: LivenessLedgerSchema.optional(),
});
export type WardenAnomaly = z.infer<typeof WardenAnomalySchema>;

export const WardenFailoverAccountViewSchema = z.object({
  agent: z.string().min(1),
  model: z.string().optional(),
  eligible: z.boolean(),
  reason: z.string().optional(),
  demotedUntil: InstantSchema.optional(),
  strikes: NonNegativeIntegerSchema.optional(),
  quota: z
    .object({
      fiveHourPercent: z.number().finite().min(0).max(100).optional(),
      weeklyPercent: z.number().finite().min(0).max(100).optional(),
      atLimit: z.boolean().optional(),
      authOk: z.boolean().optional(),
    })
    .optional(),
});
export type WardenFailoverAccountView = z.infer<typeof WardenFailoverAccountViewSchema>;

export const WardenFailoverStatusSchema = z.object({
  policy: WardenFailoverPolicySchema,
  failureThreshold: PositiveIntegerSchema,
  cooldownMinutes: PositiveIntegerSchema,
  accounts: z.array(WardenFailoverAccountViewSchema),
  lastSelection: z
    .object({ agent: z.string().min(1), policy: WardenFailoverPolicySchema, at: InstantSchema, reason: z.string() })
    .optional(),
  exhaustedSince: InstantSchema.optional(),
});
export type WardenFailoverStatus = z.infer<typeof WardenFailoverStatusSchema>;

export const WardenConfigViewSchema = z.object({
  config: WardenConfigSchema,
  accounts: z.array(WardenAccountSchema).min(1),
  warnings: z.array(z.string()),
});
export type WardenConfigView = z.infer<typeof WardenConfigViewSchema>;

export const WardenStatusViewSchema = z.object({
  config: WardenConfigSchema,
  lastSweepAt: InstantSchema.optional(),
  anomalies: z.array(WardenAnomalySchema),
  fingerprint: z.string(),
  liveWarden: z.string().optional(),
  lastSpawnAt: InstantSchema.optional(),
  lastReport: z.object({ reportId: z.string().min(1), head: z.string() }).optional(),
  failover: WardenFailoverStatusSchema.optional(),
});
export type WardenStatusView = z.infer<typeof WardenStatusViewSchema>;

/** A concise, scan-friendly index of warden reports. The full LLM-authored
 * evidence remains reachable through the report route; this does not duplicate
 * or replace it. */
export const WardenVerdictKindSchema = z.enum(['killed', 'revived', 'nudged', 'cleared', 'needs_human', 'unknown']);
export type WardenVerdictKind = z.infer<typeof WardenVerdictKindSchema>;

export const WardenRecommendedActionSchema = z.enum(['nudge', 'stop', 'resume', 'restart', 'migrate', 'leave']);
export type WardenRecommendedAction = z.infer<typeof WardenRecommendedActionSchema>;

export const WardenRecommendationSchema = z.object({
  action: WardenRecommendedActionSchema,
  reason: z.string(),
  agent: z.string().min(1).optional(),
});
export type WardenRecommendation = z.infer<typeof WardenRecommendationSchema>;

/** Daemon-owned provenance, copied only from a validated report sidecar. */
export const WardenVerdictSpawnSchema = z.object({
  agent: z.string().min(1),
  model: z.string().min(1),
  modelSource: z.enum(['harness', 'agent', 'configured', 'unknown']),
  harness: z.enum(['claude', 'codex']),
  failedOver: z.boolean(),
  policy: WardenFailoverPolicySchema,
  selection: z.enum(['preferred', 'failover', 'rotation']),
  configuredFirst: z.string().min(1),
  skipped: z.record(z.string(), z.string()),
});
export type WardenVerdictSpawn = z.infer<typeof WardenVerdictSpawnSchema>;

export const WardenVerdictSchema = z.object({
  at: InstantSchema,
  targetSession: z.string().min(1).optional(),
  teammate: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  anomalyKind: WardenAnomalyKindSchema.optional(),
  verdict: WardenVerdictKindSchema,
  explicitNeedsHuman: z.boolean().optional(),
  recommendation: WardenRecommendationSchema.optional(),
  reason: z.string().min(1).optional(),
  reportPath: z.string().min(1),
  spawn: WardenVerdictSpawnSchema.optional(),
});
export type WardenVerdict = z.infer<typeof WardenVerdictSchema>;

export const WardenVerdictsViewSchema = z.array(WardenVerdictSchema);
export type WardenVerdictsView = z.infer<typeof WardenVerdictsViewSchema>;

export const WardenRunViewSchema = z.object({
  sweptAt: InstantSchema,
  anomalies: z.array(WardenAnomalySchema),
  spawned: z.string().optional(),
  assignedWardens: z.array(z.string()).optional(),
  message: z.string().optional(),
});
export type WardenRunView = z.infer<typeof WardenRunViewSchema>;

export const WardenRunRequestSchema = z.strictObject({
  spawn: z.boolean().default(false),
});
export type WardenRunRequest = z.infer<typeof WardenRunRequestSchema>;
export type WardenRunRequestInput = z.input<typeof WardenRunRequestSchema>;

export const UsageAccountViewSchema = z.object({
  agent: z.string().min(1),
  usageBased: z.boolean().optional(),
  provider: z.string().optional(),
  availability: AccountAvailabilitySchema.optional(),
  unavailable: z.boolean().optional(),
  unavailableReason: AccountUnavailableReasonSchema.optional(),
  retryAt: NonNegativeFiniteSchema.optional(),
  fiveHourPercent: z.number().finite().min(0).max(100).optional(),
  weeklyPercent: z.number().finite().min(0).max(100).optional(),
  fiveHourResetAt: NonNegativeFiniteSchema.optional(),
  weeklyResetAt: NonNegativeFiniteSchema.optional(),
  atLimit: z.boolean().optional(),
  authOk: z.boolean().optional(),
});
export type UsageAccountView = z.infer<typeof UsageAccountViewSchema>;

export const UsageFeedViewSchema = z.object({
  at: InstantSchema.optional(),
  stale: z.boolean(),
  accounts: z.array(UsageAccountViewSchema),
});
export type UsageFeedView = z.infer<typeof UsageFeedViewSchema>;

const AttachmentExtractionSchema = z
  .object({
    method: z.enum(['pdfjs', 'docx-xml']),
    characters: NonNegativeIntegerSchema,
    truncated: z.boolean(),
    totalPages: PositiveIntegerSchema.optional(),
    pagesRead: NonNegativeIntegerSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.totalPages === undefined) !== (value.pagesRead === undefined)) {
      context.addIssue({ code: 'custom', message: 'totalPages and pagesRead must appear together' });
    }
    if (value.pagesRead !== undefined && value.totalPages !== undefined && value.pagesRead > value.totalPages) {
      context.addIssue({ code: 'custom', message: 'pagesRead may not exceed totalPages', path: ['pagesRead'] });
    }
    if (value.method === 'docx-xml' && value.totalPages !== undefined) {
      context.addIssue({ code: 'custom', message: 'page counts are valid only for PDF extraction' });
    }
  });

const AttachmentExtractionFailureSchema = z.object({
  code: z.enum([
    'password_protected_document',
    'no_extractable_text',
    'unreadable_document',
    'document_extraction_timeout',
    'document_too_complex',
  ]),
  message: z.string().min(1),
});

const AttachmentEncryptionSchema = z.discriminatedUnion('locked', [
  z.object({ kind: z.literal('pdf'), locked: z.literal(true) }),
  z.object({
    kind: z.literal('pdf'),
    locked: z.literal(false),
    expiresAt: InstantSchema,
    decryptedSize: PositiveIntegerSchema,
  }),
]);

export const AttachmentViewSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
    mime: z.string().min(1),
    size: NonNegativeIntegerSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    createdAt: InstantSchema,
    textExtraction: AttachmentExtractionSchema.optional(),
    textExtractionFailure: AttachmentExtractionFailureSchema.optional(),
    encrypted: AttachmentEncryptionSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.textExtraction !== undefined && value.textExtractionFailure !== undefined) {
      context.addIssue({ code: 'custom', message: 'extraction success and failure are mutually exclusive' });
    }
    if (value.encrypted?.locked === true && value.textExtraction !== undefined) {
      context.addIssue({ code: 'custom', message: 'a locked attachment cannot expose extracted text' });
    }
  });
export type AttachmentView = z.infer<typeof AttachmentViewSchema>;

/** JSON avoids making the daemon's transport layer buffer multipart bodies outside its bounded API seam. */
export const AttachmentUploadRequestSchema = z.strictObject({
  filename: z.string().trim().min(1).max(255),
  mime: z.string().trim().min(1).max(255),
  base64: z.string().min(1),
});
export type AttachmentUploadRequest = z.infer<typeof AttachmentUploadRequestSchema>;

export const AttachmentUnlockRequestSchema = z.strictObject({ password: z.string().min(1).max(4_096) });
export type AttachmentUnlockRequest = z.infer<typeof AttachmentUnlockRequestSchema>;

export const AttachmentDownloadSchema = z.strictObject({ attachment: AttachmentViewSchema, base64: z.string().min(1) });
export type AttachmentDownload = z.infer<typeof AttachmentDownloadSchema>;

export const ScratchEntrySchema = z.object({
  name: z.string().min(1),
  bytes: NonNegativeIntegerSchema,
  kind: z.enum(['file', 'directory', 'symlink']),
});
export type ScratchEntry = z.infer<typeof ScratchEntrySchema>;

/** Moving this view out of the daemon dissolves the former service/manager cycle. */
const ScratchPlanBaseShape = {
  sessionId: z.string().min(1),
  teammate: z.string().optional(),
  directory: z.string().min(1),
  bytes: NonNegativeIntegerSchema,
  entries: z.array(ScratchEntrySchema),
};

export const ScratchPlanViewSchema = z.discriminatedUnion('eligible', [
  z.object({ ...ScratchPlanBaseShape, eligible: z.literal(true), reason: z.undefined().optional() }),
  z.object({ ...ScratchPlanBaseShape, eligible: z.literal(false), reason: z.string().min(1) }),
]);
export type ScratchPlanView = z.infer<typeof ScratchPlanViewSchema>;

export const ScratchPlanListSchema = z.array(ScratchPlanViewSchema);
export type ScratchPlanList = z.infer<typeof ScratchPlanListSchema>;

export const ScratchSweepViewSchema = z.object({
  sessions: NonNegativeIntegerSchema,
  bytes: NonNegativeIntegerSchema,
  failures: NonNegativeIntegerSchema,
});
export type ScratchSweepView = z.infer<typeof ScratchSweepViewSchema>;

export const ScratchSweepRequestSchema = z.strictObject({
  force: z.boolean().default(false),
});
export type ScratchSweepRequest = z.infer<typeof ScratchSweepRequestSchema>;
export type ScratchSweepRequestInput = z.input<typeof ScratchSweepRequestSchema>;

export const EmptyResponseSchema = z.undefined();
