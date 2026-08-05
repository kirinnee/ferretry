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
  // Codex's native picker can be opened without selecting a target. It is a
  // real control operation, but deliberately makes no claim about the eventual
  // model; targeted callers supply both opaque values unchanged.
  z.strictObject({
    action: z.literal('model'),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  }),
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

/**
 * How this session's harness transcript was IDENTIFIED.
 *
 * `minted` — the daemon chose the harness session id itself and put it on the launch argv, so the
 * transcript's name was decided before the harness ran. Nothing was inferred.
 * `correlated` — the harness named its own session, and the daemon proved which one by finding a
 * string only this session could contain in a rollout that did not exist before the launch.
 * `undiscovered` — neither proof is available yet. A session in this state has NO transcript, which
 * is the point: attributing one by working directory or recency silently hands one agent's
 * transcript to another session and the mistake is invisible.
 */
export const TranscriptIdentitySchema = z.enum(['minted', 'correlated', 'undiscovered']);
export type TranscriptIdentity = z.infer<typeof TranscriptIdentitySchema>;

/**
 * Where this session's transcript lives, recorded as evidence captured at launch.
 *
 * This is a PROVENANCE record, not a cache. Every field is something the daemon observed or decided
 * at the moment the session was created — the harness home the wrapper exports, the session id the
 * daemon minted, the rollouts that already existed before this launch — because after the fact
 * there is no way to tell two concurrent sessions of the same agent in the same directory apart.
 */
export const TranscriptProvenanceSchema = z
  .object({
    v: z.literal(1),
    /** The harness's own private home, as the launched wrapper exports it. */
    home: z.string().min(1),
    /** The harness's identity for this session, once it is known. */
    harnessSessionId: z.string().min(1).optional(),
    identity: TranscriptIdentitySchema,
    /**
     * The harness session ids that already existed when this session launched.
     *
     * Recorded only for a harness that names its own session (Codex). Everything listed here
     * belongs to somebody else by construction, so a later discovery can exclude all of it without
     * having to reason about time.
     */
    baseline: z.array(z.string().min(1)).optional(),
    /**
     * A string this daemon injected into this session and into no other.
     *
     * It is the whole proof behind `correlated`: a rollout containing it was written by this
     * session, and a rollout that does not is not this session's however recent it is.
     */
    correlationToken: z.string().min(1).optional(),
    /** The exact transcript file. Present exactly when the identity is established. */
    file: z.string().min(1).optional(),
    /** When the identity was established. */
    resolvedAt: InstantSchema.optional(),
  })
  .refine(value => (value.identity === 'undiscovered') === (value.harnessSessionId === undefined), {
    message: 'an identified transcript must name the harness session it belongs to',
    path: ['harnessSessionId'],
  })
  .refine(value => (value.identity === 'undiscovered') === (value.file === undefined), {
    message: 'an identified transcript must name its file',
    path: ['file'],
  });
export type TranscriptProvenance = z.infer<typeof TranscriptProvenanceSchema>;

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
  /**
   * Optional because a session started before this record existed has none, and because a harness
   * home the daemon cannot resolve must leave the session with no transcript rather than a guessed
   * one.
   */
  transcript: TranscriptProvenanceSchema.optional(),
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
  /** The exact structured form the daemon confirmed as advanced; prevents a
   * transcript tail from resurrecting that already-answered tool call. */
  lastAnsweredQuestionToolUseId: z.string().min(1).optional(),
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

/**
 * The exact tmux process a daemon proved belongs to one managed session.
 *
 * This is deliberately separate from {@link SessionConfigSchema}. A public session view describes
 * the work; it is not authority to address a host runtime. The attach route returns this short-lived
 * proof only after matching the daemon's durable pane registration against a fresh observation, and
 * the CLI checks the same identity once more immediately before it asks tmux to attach.
 */
export const SessionAttachTargetSchema = z.strictObject({
  /** The private tmux server owned by the daemon that answered the request. */
  socketPath: z.string().min(1).regex(/^\//u, 'the tmux socket path must be absolute'),
  tmuxSession: z.string().min(1),
  paneId: z.string().regex(/^%[1-9][0-9]*$/u),
  pid: PositiveIntegerSchema.refine(value => value > 1, 'the pane pid must be greater than one'),
  /** Linux `/proc/<pid>/stat` start ticks, which distinguish a reused PID. */
  processStartTicks: PositiveIntegerSchema,
});
export type SessionAttachTarget = z.infer<typeof SessionAttachTargetSchema>;

export const NameSuggestionsSchema = z.array(z.string().min(1));
export type NameSuggestions = z.infer<typeof NameSuggestionsSchema>;

export const FyEventSourceSchema = z.string().min(1);

/**
 * Generic event envelope. Event-specific payload schemas parse `data` after dispatch.
 *
 * WHY `turn` IS OPTIONAL. The daemon's durable session journal records exactly four things about an
 * event — its sequence, its time, its type and its data — and nothing about the turn it happened
 * during. A required `turn` therefore forced the only mounted producer to invent one, and `turn: 0`
 * on every replayed event is not a missing number, it is a WRONG one: a reader grouping by turn
 * would render a session's whole history as a single opening turn. Absent says "the daemon does not
 * record this", which is the truth, and it is the shape every consumer can act on honestly.
 */
export const FyEventSchema = z.object({
  sequence: NonNegativeIntegerSchema,
  time: InstantSchema,
  sessionId: z.string().min(1),
  turn: NonNegativeIntegerSchema.optional(),
  type: z.string().min(1),
  source: FyEventSourceSchema,
  data: z.unknown(),
  recordUuid: z.string().optional(),
  blockIndex: NonNegativeIntegerSchema.optional(),
});
export type FyEvent = z.infer<typeof FyEventSchema>;

export const FyEventListSchema = z.array(FyEventSchema);
export type FyEventList = z.infer<typeof FyEventListSchema>;

/** Proof that a live event socket is quiet rather than broken. */
export const FyEventStreamIdleScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    sessionId: z.string().min(1),
    /** This session's own last delivered sequence. */
    after: NonNegativeIntegerSchema,
  }),
  z.strictObject({
    kind: z.literal('fleet'),
    /** Sessions in the daemon-local fleet at the instant the proof was emitted. */
    followedSessions: NonNegativeIntegerSchema,
  }),
]);
export type FyEventStreamIdleScope = z.infer<typeof FyEventStreamIdleScopeSchema>;

/**
 * One frame on `/v1/events`.
 *
 * The wrapper keeps a heartbeat from masquerading as a session event: an idle proof has no invented
 * session id, sequence, or lifecycle type, while an event still passes through the exact envelope
 * every replay and history reader uses.
 */
export const FyEventStreamFrameSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('event'), event: FyEventSchema }),
  z.strictObject({
    kind: z.literal('idle'),
    idleSeconds: PositiveIntegerSchema,
    scope: FyEventStreamIdleScopeSchema,
  }),
]);
export type FyEventStreamFrame = z.infer<typeof FyEventStreamFrameSchema>;
export type FyEventStreamIdle = Extract<FyEventStreamFrame, { readonly kind: 'idle' }>;

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

/**
 * One answer in an ordered structured-question set.
 *
 * The legacy `labels`/`other`/`responses` fields below cannot represent a
 * multi-select question inside a multi-question set: `responses` has room for
 * only one string per question.  This discriminated shape is deliberately
 * exclusive, so a free-form answer can never be mistaken for an option label,
 * and preserves every selected label in question order.
 */
export const StructuredQuestionAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('selection'),
    labels: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    kind: z.literal('other'),
    text: z.string().trim().min(1),
  }),
]);
export type StructuredQuestionAnswer = z.infer<typeof StructuredQuestionAnswerSchema>;

export const AnswerSessionRequestSchema = z.strictObject({
  toolUseId: z.string().min(1),
  labels: z.array(z.string().min(1)),
  other: z.string().optional(),
  responses: z.array(z.string()).optional(),
  /** Lossless ordered answers. Legacy fields remain for older callers. */
  answers: z.array(StructuredQuestionAnswerSchema).min(1).optional(),
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
