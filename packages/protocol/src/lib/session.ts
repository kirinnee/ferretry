import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

export const HarnessSchema = z.enum(['claude', 'codex']);
export type Harness = z.infer<typeof HarnessSchema>;

export const InteractionModeSchema = z.enum(['auto', 'interactive']);
export type InteractionMode = z.infer<typeof InteractionModeSchema>;

export const SendFateSchema = z.enum(['accepted', 'delivered', 'unaccounted']);
export type SendFate = z.infer<typeof SendFateSchema>;

export const SendPathSchema = z.enum(['direct', 'turn-file', 'native-inline', 'native-file', 'revive', 'revive-queue']);
export type SendPath = z.infer<typeof SendPathSchema>;

export const SendUnaccountedReasonSchema = z.enum(['timeout', 'session_ended', 'composer_discarded']);
export type SendUnaccountedReason = z.infer<typeof SendUnaccountedReasonSchema>;

export const SendEvidenceSchema = z.object({
  key: z.string().min(1),
  harness: HarnessSchema,
  kind: z.enum(['chat.user', 'queued_command', 'response_item']),
  proof: z.enum(['normal-user-record', 'native-queue-drain']),
  observedAt: InstantSchema,
  originatedAt: InstantSchema.optional(),
  shapeVersion: PositiveIntegerSchema,
  matchedTurn: NonNegativeIntegerSchema,
  tier: z.enum(['queue-file-id', 'turn-instruction', 'exact-text']),
});
export type SendEvidence = z.infer<typeof SendEvidenceSchema>;

/** Public send-ledger row. Private payload paths never cross the API boundary. */
export const SendRecordSchema = z.object({
  v: z.literal(1),
  sendId: z.string().min(1),
  acceptedAt: InstantSchema,
  acceptedTurn: NonNegativeIntegerSchema,
  path: SendPathSchema,
  message: z.string(),
  turn: NonNegativeIntegerSchema.optional(),
  attachmentIds: z.array(z.string()),
  from: z.string().optional(),
  fromName: z.string().optional(),
  replyExpected: z.boolean().optional(),
  held: z.boolean().optional(),
  withdrawn: z.boolean().optional(),
  fate: SendFateSchema,
  fateAt: InstantSchema.optional(),
  evidence: SendEvidenceSchema.optional(),
  unaccountedReason: SendUnaccountedReasonSchema.optional(),
  opportunityAt: InstantSchema.optional(),
  unaccountedDeadline: InstantSchema.optional(),
  hardDeadline: InstantSchema.optional(),
  timeoutFrozenAt: InstantSchema.optional(),
});
export type SendRecord = z.infer<typeof SendRecordSchema>;

export const SendListResponseSchema = z.object({ sends: z.array(SendRecordSchema) });
export type SendListResponse = z.infer<typeof SendListResponseSchema>;

export const RuntimeModelOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});
export type RuntimeModelOption = z.infer<typeof RuntimeModelOptionSchema>;

export const RuntimeReasoningChoiceSchema = z.object({
  value: z.string().min(1),
  description: z.string().optional(),
});
export type RuntimeReasoningChoice = z.infer<typeof RuntimeReasoningChoiceSchema>;

export const RuntimeModelChoiceSchema = RuntimeModelOptionSchema.extend({
  description: z.string().optional(),
  isDefault: z.literal(true).optional(),
  reasoningEfforts: z.array(RuntimeReasoningChoiceSchema),
  defaultReasoningEffort: z.string().min(1).optional(),
});
export type RuntimeModelChoice = z.infer<typeof RuntimeModelChoiceSchema>;

export const RuntimeModelCatalogSchema = z.object({
  harness: HarnessSchema,
  source: z.enum(['wrapper-inventory', 'codex-app-server']),
  choices: z.array(RuntimeModelChoiceSchema),
});
export type RuntimeModelCatalog = z.infer<typeof RuntimeModelCatalogSchema>;

export const RuntimeControlRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('model'), model: z.string().min(1) }),
  z.strictObject({ action: z.literal('effort'), effort: z.string().min(1) }),
  z.strictObject({ action: z.literal('compact') }),
]);
export type RuntimeControlRequest = z.infer<typeof RuntimeControlRequestSchema>;

export const SessionStatusSchema = z.enum([
  'created',
  'starting',
  'running',
  'thinking',
  'tool_running',
  'awaiting_question',
  'awaiting_user',
  'interrupted',
  'rate_limited',
  'retrying',
  'kill_failed',
  'waiting',
  'completed',
  'failed',
  'stalled',
  'stopped',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const PendingQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
export type PendingQuestionOption = z.infer<typeof PendingQuestionOptionSchema>;

export const PendingQuestionSchema = z.object({
  toolUseId: z.string().min(1),
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().optional(),
        options: z.array(PendingQuestionOptionSchema).optional(),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1),
  askedAt: InstantSchema.optional(),
  lastSeenAt: InstantSchema.optional(),
  missingSince: InstantSchema.optional(),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

export const TaskBoardAccessSchema = z.enum(['none', 'read', 'worker', 'coordinator']);
export type TaskBoardAccess = z.infer<typeof TaskBoardAccessSchema>;

const RetryPolicySchema = z.object({
  transientAttempts: NonNegativeIntegerSchema,
  stalledAttempts: NonNegativeIntegerSchema,
  waitForQuotaReset: z.boolean(),
  allowAccountFailover: z.boolean(),
});

/** Effective, safe-to-publish session configuration. */
export const SessionConfigSchema = z.object({
  id: z.string().min(1),
  incarnation: z.string().min(1),
  runtimeGeneration: PositiveIntegerSchema,
  name: z.string().min(1),
  teammate: z.string().optional(),
  label: z.string().optional(),
  parent: z.string().optional(),
  boardAccess: TaskBoardAccessSchema,
  agent: z.string().min(1),
  harness: HarnessSchema,
  modelHint: z.string(),
  model: z.string().optional(),
  mode: InteractionModeSchema,
  remoteControl: z.boolean(),
  harnessFlags: z.array(z.string()),
  cwd: z.string().min(1),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  turn: NonNegativeIntegerSchema,
  intervalSeconds: PositiveIntegerSchema,
  timeoutSeconds: NonNegativeIntegerSchema,
  nudgeAfterSeconds: NonNegativeIntegerSchema,
  killAfterSeconds: NonNegativeIntegerSchema,
  directSendMaxChars: NonNegativeIntegerSchema,
  resumeMenuChoice: z.enum(['full', 'summary']),
  maxSnapshots: PositiveIntegerSchema,
  migration: z
    .object({
      from: z.string().min(1),
      to: z.string().min(1),
      at: InstantSchema,
    })
    .optional(),
  retry: RetryPolicySchema,
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export const SessionHealthSchema = z.enum([
  'healthy',
  'thinking',
  'waiting',
  'idle',
  'stalled',
  'rate_limited',
  'crashed',
  'unknown',
]);
export type SessionHealth = z.infer<typeof SessionHealthSchema>;

export const AccountAvailabilitySchema = z.enum(['available', 'unavailable']);
export type AccountAvailability = z.infer<typeof AccountAvailabilitySchema>;

export const AccountUnavailableReasonSchema = z.enum(['cooldown', 'spend_limit', 'auth', 'provider', 'no_credentials']);
export type AccountUnavailableReason = z.infer<typeof AccountUnavailableReasonSchema>;

/** Upstream account-health row. It also breaks the former core/usage type cycle. */
export const AccountUsageSchema = z.object({
  agent: z.string().min(1),
  provider: z.string().optional(),
  ok: z.boolean().optional(),
  usageBased: z.boolean().optional(),
  availability: AccountAvailabilitySchema.optional(),
  unavailable: z.boolean().optional(),
  unavailableReason: AccountUnavailableReasonSchema.optional(),
  retryAt: NonNegativeFiniteSchema.nullable().optional(),
  atLimit: z.boolean().optional(),
  authOk: z.boolean().optional(),
  fiveHourPercent: z.number().finite().min(0).max(100).nullable().optional(),
  weeklyPercent: z.number().finite().min(0).max(100).nullable().optional(),
  fiveHourResetAt: NonNegativeFiniteSchema.nullable().optional(),
  weeklyResetAt: NonNegativeFiniteSchema.nullable().optional(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

const QuotaSchema = z.object({
  usageBased: z.boolean().optional(),
  availability: AccountAvailabilitySchema.optional(),
  unavailable: z.boolean().optional(),
  unavailableReason: AccountUnavailableReasonSchema.optional(),
  retryAt: NonNegativeFiniteSchema.optional(),
  atLimit: z.boolean().optional(),
  authOk: z.boolean().optional(),
  provider: z.string().optional(),
  fiveHourPercent: z.number().finite().min(0).max(100).optional(),
  weeklyPercent: z.number().finite().min(0).max(100).optional(),
  fiveHourResetAt: NonNegativeFiniteSchema.optional(),
  weeklyResetAt: NonNegativeFiniteSchema.optional(),
  resetAt: NonNegativeFiniteSchema.optional(),
});

const DeclaredWaitSchema = z.object({
  since: InstantSchema,
  until: InstantSchema.optional(),
  condition: z.string().optional(),
  peer: z.string().optional(),
  peerName: z.string().optional(),
});

/** Public session state; internal queue payloads and filesystem proofs are omitted. */
export const SessionStateSchema = z.object({
  id: z.string().min(1),
  status: SessionStatusSchema,
  turn: NonNegativeIntegerSchema,
  pid: PositiveIntegerSchema.optional(),
  startedAt: InstantSchema.optional(),
  finishedAt: InstantSchema.optional(),
  lastActivityAt: InstantSchema.optional(),
  lastSnapshotAt: InstantSchema.optional(),
  lastDiffAt: InstantSchema.optional(),
  exitCode: z.number().int().optional(),
  reason: z.string().optional(),
  health: SessionHealthSchema.optional(),
  promptReady: z.boolean().optional(),
  remoteControlUrl: z.url().optional(),
  openTools: z.array(z.string()).optional(),
  pendingQuestion: PendingQuestionSchema.nullable().optional(),
  lastTranscriptAt: InstantSchema.optional(),
  lastPaneAt: InstantSchema.optional(),
  lastCounterAdvanceAt: InstantSchema.optional(),
  lastTokenAdvanceAt: InstantSchema.optional(),
  lastSubprocessAt: InstantSchema.optional(),
  subprocessSince: InstantSchema.optional(),
  nudgedAt: InstantSchema.optional(),
  needsHuman: z.string().optional(),
  needsHumanKind: z.string().optional(),
  contextPercent: z.number().finite().min(0).max(100).optional(),
  contextTokens: NonNegativeIntegerSchema.optional(),
  contextWindow: PositiveIntegerSchema.optional(),
  usage5hPercent: z.number().finite().min(0).max(100).optional(),
  usageWeeklyPercent: z.number().finite().min(0).max(100).optional(),
  usage5hResetAt: NonNegativeFiniteSchema.optional(),
  usageWeeklyResetAt: NonNegativeFiniteSchema.optional(),
  usageAtLimit: z.boolean().optional(),
  usageAuthOk: z.boolean().optional(),
  launchedAt: InstantSchema.optional(),
  observedModel: z.string().optional(),
  observedModelAt: InstantSchema.optional(),
  observedReasoningEffort: z.string().optional(),
  activity: z.string().optional(),
  lastToolStartedAt: InstantSchema.optional(),
  quota: QuotaSchema.optional(),
  retryAttempt: NonNegativeIntegerSchema.optional(),
  turnCompleted: z.boolean().optional(),
  waiting: DeclaredWaitSchema.optional(),
  waitingCreditSeconds: NonNegativeFiniteSchema.optional(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SessionViewSchema = z.object({
  config: SessionConfigSchema,
  state: SessionStateSchema,
  directory: z.string().min(1),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const SessionListSchema = z.array(SessionViewSchema);
export type SessionList = z.infer<typeof SessionListSchema>;

export const NameSuggestionsSchema = z.array(z.string().min(1));
export type NameSuggestions = z.infer<typeof NameSuggestionsSchema>;

export const FyEventSourceSchema = z.string().min(1);

/** Generic event envelope. Event-specific payload schemas parse `data` after dispatch. */
export const FyEventSchema = z.object({
  sequence: NonNegativeIntegerSchema,
  time: InstantSchema,
  sessionId: z.string().min(1),
  turn: NonNegativeIntegerSchema,
  type: z.string().min(1),
  source: FyEventSourceSchema,
  data: z.unknown(),
  recordUuid: z.string().optional(),
  blockIndex: NonNegativeIntegerSchema.optional(),
});
export type FyEvent = z.infer<typeof FyEventSchema>;

export const FyEventListSchema = z.array(FyEventSchema);
export type FyEventList = z.infer<typeof FyEventListSchema>;

const StartSessionBaseSchema = z.strictObject({
  agent: z.string().min(1),
  name: z.string().min(1).optional(),
  teammate: z.string().min(1).optional(),
  teammateFallback: z.boolean().optional(),
  label: z.string().min(1).optional(),
  parent: z.string().min(1).optional(),
  boardAccess: TaskBoardAccessSchema.default('none'),
  cwd: z.string().min(1).optional(),
  remoteControl: z.boolean().optional(),
  harnessFlags: z.array(z.string()).optional(),
  model: z.string().min(1).optional(),
  intervalSeconds: PositiveIntegerSchema.optional(),
  timeoutSeconds: NonNegativeIntegerSchema.optional(),
  nudgeAfterSeconds: NonNegativeIntegerSchema.optional(),
  killAfterSeconds: NonNegativeIntegerSchema.optional(),
  directSendMaxChars: NonNegativeIntegerSchema.optional(),
  resumeMenuChoice: z.enum(['full', 'summary']).optional(),
  maxSnapshots: PositiveIntegerSchema.optional(),
  detach: z.boolean().optional(),
  initialAttachments: z
    .array(
      z.strictObject({
        filename: z.string().min(1),
        mime: z.string().min(1).optional(),
        base64: z
          .string()
          .min(1)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
      }),
    )
    .optional(),
});

export const StartSessionRequestSchema = z
  .discriminatedUnion('mode', [
    StartSessionBaseSchema.extend({ mode: z.literal('auto'), prompt: z.string().trim().min(1) }),
    StartSessionBaseSchema.extend({ mode: z.literal('interactive'), prompt: z.string().trim().min(1).optional() }),
  ])
  .superRefine((value, context) => {
    if (value.boardAccess !== 'none' && value.parent === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'parent is required when board access is requested',
        path: ['parent'],
      });
    }
    if (value.boardAccess !== 'none' && value.mode !== 'auto') {
      context.addIssue({
        code: 'custom',
        message: 'board access is available only for auto sessions',
        path: ['boardAccess'],
      });
    }
  });
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;
export type StartSessionRequestInput = z.input<typeof StartSessionRequestSchema>;

/** Client-authored fields only; actor identity and idempotency come from headers. */
export const SendRequestSchema = z.strictObject({
  message: z.string().min(1),
  attachmentIds: z.array(z.string()).optional(),
  now: z.boolean().optional(),
  replyExpected: z.boolean().optional(),
});
export type SendRequest = z.infer<typeof SendRequestSchema>;

export const AnswerSessionRequestSchema = z.strictObject({
  toolUseId: z.string().min(1),
  labels: z.array(z.string().min(1)),
  other: z.string().optional(),
  responses: z.array(z.string()).optional(),
});
export type AnswerSessionRequest = z.infer<typeof AnswerSessionRequestSchema>;

export const InterruptSessionRequestSchema = z.strictObject({ toolUseId: z.string().min(1).optional() });
export type InterruptSessionRequest = z.infer<typeof InterruptSessionRequestSchema>;

export const StopSessionRequestSchema = z.strictObject({
  reason: z.string().min(1).optional(),
});
export type StopSessionRequest = z.infer<typeof StopSessionRequestSchema>;

export const ResumeSessionRequestSchema = z.strictObject({
  message: z.string().min(1).optional(),
});
export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>;

export const MigrateSessionRequestSchema = z.strictObject({
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
  allowContextDowngrade: z.boolean().default(false),
});
export type MigrateSessionRequest = z.infer<typeof MigrateSessionRequestSchema>;
export type MigrateSessionRequestInput = z.input<typeof MigrateSessionRequestSchema>;

export const RenameSessionRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).optional(),
    teammate: z.string().trim().min(1).optional(),
    clearParent: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.name === undefined && value.teammate === undefined && value.clearParent !== true) {
      context.addIssue({ code: 'custom', message: 'name, teammate, or clearParent is required' });
    }
  });
export type RenameSessionRequest = z.infer<typeof RenameSessionRequestSchema>;

export const SendDispositionSchema = z.enum(['delivered', 'queued', 'revived', 'queued-for-revive']);
export type SendDisposition = z.infer<typeof SendDispositionSchema>;

export const SendResultSchema = SessionViewSchema.extend({
  disposition: SendDispositionSchema,
});
export type SendResult = z.infer<typeof SendResultSchema>;

export const SignalKindSchema = z.enum(['done', 'help', 'waiting', 'working']);
export type SignalKind = z.infer<typeof SignalKindSchema>;

export const SignalOptionsSchema = z.strictObject({
  until: z.string().min(1).optional(),
  condition: z.string().min(1).optional(),
  peer: z.string().min(1).optional(),
});
export type SignalOptions = z.infer<typeof SignalOptionsSchema>;

export const SignalSessionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('done'), message: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('help'), message: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('waiting'),
    message: z.string().min(1).optional(),
    until: z.string().min(1).optional(),
    condition: z.string().min(1).optional(),
    peer: z.string().min(1).optional(),
  }),
  z.strictObject({ kind: z.literal('working'), message: z.string().min(1).optional() }),
]);
export type SignalSessionRequest = z.infer<typeof SignalSessionRequestSchema>;
