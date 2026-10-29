import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { ProviderQuotaBalanceSchema } from './fleet-credentials.ts';
import { IoPressureViewSchema } from './io-pressure.ts';
import { SessionWorkerPoolSchema } from './performance.ts';
import { AccountAvailabilitySchema, AccountUnavailableReasonSchema } from './session.ts';

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
  /** How the running sessions are observed: the pool size and sessions per worker thread. Absent from an older daemon. */
  sessionWorkers: SessionWorkerPoolSchema.optional(),
  /**
   * What this daemon build can do that an older one could not (`daemon-features.ts`). Absent from an
   * older daemon, which is how the app learns it must keep the older behaviour. Strings rather than an
   * enum, so a feature a newer daemon adds does not fail an older app.
   */
  features: z.array(z.string()).optional(),
  /** The disk's pressure now, where the host reports it (Linux PSI). Absent from an older daemon and from a host without PSI. */
  io: IoPressureViewSchema.optional(),
  time: InstantSchema,
});
export type HealthView = z.infer<typeof HealthViewSchema>;

/**
 * `GET /healthz`: liveness, answered from the moment the daemon's address is bound.
 *
 * `status` is `starting` while no route beyond this one is mounted, and `ok` from then on. `boot` says
 * which step a boot is on and for how long — so "the process exists but nothing answers" can become
 * "starting: first self-check, 40s" — and `eventLoop` says how late the loop has been running, which is
 * what separates a daemon that is busy from one that is wedged. Both are optional on the wire because a
 * daemon from before them answers with neither.
 */
/**
 * One event-loop stall: when, how long, the labelled work that overlapped it, the deepest of those
 * labels, and where the sampled stack spent it. The last two are optional because a daemon older than
 * them reports only the first three.
 */
const LoopStallViewSchema = z.object({
  at: InstantSchema,
  durationMs: NonNegativeFiniteSchema,
  during: z.array(z.string()),
  innermost: z.array(z.string()).optional(),
  stacks: z.array(z.object({ stack: z.string(), share: z.number().finite().min(0).max(1) })).optional(),
  /** Set when the disk was saturated while the loop was stalled, so the stall reads as slow rather than dead. */
  cause: z.literal('disk').optional(),
  /** The disk's pressure as the stall was recorded. */
  io: IoPressureViewSchema.optional(),
});

export const LivenessViewSchema = z.object({
  status: z.enum(['ok', 'starting']),
  version: z.string().min(1),
  sessionProtocol: z.string().optional(),
  uptimeSeconds: NonNegativeIntegerSchema,
  pid: PositiveIntegerSchema.optional(),
  boot: z
    .object({
      phase: z.enum(['starting', 'finishing', 'ready']),
      step: z.string(),
      stepElapsedSeconds: NonNegativeIntegerSchema,
      elapsedSeconds: NonNegativeIntegerSchema,
    })
    .optional(),
  eventLoop: z
    .object({
      lagMs: NonNegativeFiniteSchema,
      maxLagMs: NonNegativeFiniteSchema,
      stalls: NonNegativeIntegerSchema,
      lastStall: LoopStallViewSchema.optional(),
      worstStall: LoopStallViewSchema.optional(),
      /** The disk's pressure now, where the host reports it. */
      io: IoPressureViewSchema.optional(),
    })
    .optional(),
});
export type LivenessView = z.infer<typeof LivenessViewSchema>;

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
  /** An environment login's prepaid credit, when its provider reports one. */
  balance: ProviderQuotaBalanceSchema.optional(),
  /** Equivalent cost this month from the daemon's transcripts, when no provider endpoint answers. */
  spendUsd: NonNegativeFiniteSchema.optional(),
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
