import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { SessionStatusSchema } from './session.ts';

/**
 * THE WARDEN WIRE — the supervisor that watches every ferret, and everything a client reads or sends
 * about it: its settings, its status, the "who needs you" feed and the owner's manual request.
 *
 * THREE TIERS, AND ONLY ONE OF THEM ACTS. A free deterministic sweep flags anomalies. A TRIAGE tier
 * decides what happens to a flag: `rules` shows it to the owner and spends nothing, `llm` sends it to a
 * full investigation (kteam's behaviour), and `jev` asks Jev — TypeSafe AI's cheap decision model —
 * whether the flag deserves one. JEV IS ONLY A GUARD: its whole answer is `skip` (healthy: bless the
 * anomaly for a while) or `investigate`, and anything below the owner's threshold, or any failure,
 * counts as `investigate`. Every real action — nudge, resume, fail over, stop — comes from the verdict
 * of a read-only assigned warden, filtered by what the owner let it do alone, and stop is never on that
 * list unless the owner put it there.
 *
 * SPEND IS CAPPED PER UTC DAY, Jev and investigations separately. A cap that is hit drops the Warden to
 * rules until midnight, and the status says so: no unattended spend by surprise.
 */

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

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

/**
 * How a flag is judged. `rules` is the default on a new daemon because it is the only tier that cannot
 * spend: each of the other two is an explicit opt-in with its own daily cap.
 */
export const WardenTriageSchema = z.enum(['rules', 'llm', 'jev']);
export type WardenTriage = z.infer<typeof WardenTriageSchema>;

/** The sweep cadences a person can pick. The sweep itself is free; only what a flag leads to costs. */
export const WARDEN_SWEEP_INTERVALS = [1, 2, 5, 10, 15] as const;
export const WardenSweepIntervalSchema = z.literal(WARDEN_SWEEP_INTERVALS);
export type WardenSweepInterval = z.infer<typeof WardenSweepIntervalSchema>;

/** The skip threshold's range: Jev may skip a flag only when it is at least this sure. */
export const WARDEN_GUARD_THRESHOLD_RANGE = { min: 0.7, max: 0.95 } as const;

/**
 * Jev, as the Warden calls it. The endpoint, model and price are settings rather than constants because
 * the published descriptions of Jev disagree; the owner settles that here. The endpoint's HOST is not
 * free: the outbound holder refuses any host the Jev key is not allowed to reach, so a typo here costs a
 * refusal (and an investigation), never the key.
 */
export const WardenGuardConfigSchema = z.object({
  threshold: z.number().min(WARDEN_GUARD_THRESHOLD_RANGE.min).max(WARDEN_GUARD_THRESHOLD_RANGE.max),
  model: z.string().trim().min(1),
  endpoint: z.url({ protocol: /^https$/ }).optional(),
  /** US dollars per million input tokens, so the Jev cap can count. Configurable: sources disagree. */
  usdPerMillionInputTokens: NonNegativeFiniteSchema,
});
export type WardenGuardConfig = z.infer<typeof WardenGuardConfigSchema>;

/** A daily cap, in US dollars: more than nothing and at most a hundred. */
const DailyCapSchema = z.number().finite().gt(0).max(100);

export const WardenCapsSchema = z.object({
  jevUsdPerDay: DailyCapSchema,
  investigationUsdPerDay: DailyCapSchema,
  maxInvestigationsPerHour: z.number().int().min(1).max(60),
});
export type WardenCaps = z.infer<typeof WardenCapsSchema>;

/** What an investigation's verdict may do without asking. `stop` is off unless the owner turns it on. */
export const WardenMayActAloneSchema = z.object({
  nudge: z.boolean(),
  resume: z.boolean(),
  failover: z.boolean(),
  stop: z.boolean(),
});
export type WardenMayActAlone = z.infer<typeof WardenMayActAloneSchema>;

/** The session events that bring a sweep forward instead of waiting for the timer. */
export const WardenEventTriggersSchema = z.object({
  turnEnd: z.boolean(),
  question: z.boolean(),
  paneDied: z.boolean(),
});
export type WardenEventTriggers = z.infer<typeof WardenEventTriggersSchema>;
export type WardenEventTrigger = keyof WardenEventTriggers;

export const WardenEffortSchema = z.enum(['low', 'medium', 'high']);
export type WardenEffort = z.infer<typeof WardenEffortSchema>;

/** The investigation's own knobs. Its login and model are `accounts[0]`, the head of the failover list. */
export const WardenInvestigationConfigSchema = z.object({
  effort: WardenEffortSchema,
});
export type WardenInvestigationConfig = z.infer<typeof WardenInvestigationConfigSchema>;

export const WardenConfigSchema = z.object({
  enabled: z.boolean(),
  triage: WardenTriageSchema,
  guard: WardenGuardConfigSchema,
  caps: WardenCapsSchema,
  mayActAlone: WardenMayActAloneSchema,
  events: WardenEventTriggersSchema,
  investigation: WardenInvestigationConfigSchema,
  accounts: z.array(WardenAccountSchema).min(1),
  failover: WardenFailoverConfigSchema,
  providerOutage: ProviderOutageConfigSchema,
  intervalMinutes: WardenSweepIntervalSchema,
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
  triage: WardenTriageSchema.optional(),
  guard: WardenGuardConfigSchema.strict().partial().optional(),
  caps: WardenCapsSchema.strict().partial().optional(),
  mayActAlone: WardenMayActAloneSchema.strict().partial().optional(),
  events: WardenEventTriggersSchema.strict().partial().optional(),
  investigation: WardenInvestigationConfigSchema.strict().partial().optional(),
  accounts: z.array(WardenAccountSchema).min(1).optional(),
  failover: WardenFailoverConfigSchema.partial().optional(),
  providerOutage: ProviderOutageConfigSchema.partial().optional(),
  intervalMinutes: WardenSweepIntervalSchema.optional(),
  unattendedMinutes: PositiveIntegerSchema.optional(),
  minSpawnGapMinutes: NonNegativeIntegerSchema.optional(),
  susThinkingSeconds: PositiveIntegerSchema.optional(),
  susSubprocessSeconds: PositiveIntegerSchema.optional(),
  maxAssignedWardens: PositiveIntegerSchema.optional(),
  assignedCooldownMinutes: NonNegativeIntegerSchema.optional(),
  blessMinutes: NonNegativeIntegerSchema.optional(),
});
export type WardenConfigPatch = z.infer<typeof WardenConfigPatchSchema>;

/** The nested sections a patch merges into rather than replaces. */
export const WARDEN_CONFIG_SECTIONS = [
  'guard',
  'caps',
  'mayActAlone',
  'events',
  'investigation',
  'failover',
  'providerOutage',
] as const satisfies readonly (keyof WardenConfig)[];

/**
 * Settings merged section by section, then checked whole: an owner switching one box must not reset its
 * siblings to whatever a fresh object would carry, and a merge must never produce settings the loader
 * would later refuse. The one merge every editor uses — the daemon's PATCH and the file loader alike.
 */
export function mergeWardenConfig(
  base: WardenConfig,
  patch: Partial<{ readonly [K in keyof WardenConfig]: unknown }>,
): WardenConfig {
  const merged: Record<string, unknown> = { ...base, ...patch };
  for (const section of WARDEN_CONFIG_SECTIONS) {
    const change = patch[section];
    merged[section] = { ...base[section], ...(typeof change === 'object' && change !== null ? change : {}) };
  }
  return WardenConfigSchema.parse(merged);
}

// ── Detection ───────────────────────────────────────────────────────────────────────────────────

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
  /** Not detected: the owner asked for an investigation of this ferret. */
  'owner_request',
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

// ── Accounts ────────────────────────────────────────────────────────────────────────────────────

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

// ── Verdicts ────────────────────────────────────────────────────────────────────────────────────

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

// ── Status ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Why the triage in effect is not the one configured. `configured` means it is; every other value is a
 * fallback the status line must say out loud.
 */
export const WardenTriageReasonSchema = z.enum([
  'configured',
  /** The Warden is off: nothing is triaged and nothing is spent. */
  'disabled',
  /** Today's Jev spend reached its cap: rules until midnight UTC. */
  'jev_cap',
  /** Today's investigation spend reached its cap: rules until midnight UTC. */
  'investigation_cap',
]);
export type WardenTriageReason = z.infer<typeof WardenTriageReasonSchema>;

export const WardenGuardFailureCodeSchema = z.enum([
  'not_set',
  'vault_damaged',
  'misconfigured',
  'rejected',
  'invalid_request',
  'too_large',
  'rate_limited',
  'overloaded',
  'provider_error',
  'timeout',
  'unreachable',
  'malformed',
  /** The snapshot could not be redacted, so nothing was sent. */
  'unredacted',
]);
export type WardenGuardFailureCode = z.infer<typeof WardenGuardFailureCodeSchema>;

export const WardenTriageStatusSchema = z.object({
  configured: WardenTriageSchema,
  effective: WardenTriageSchema,
  reason: WardenTriageReasonSchema,
  /** The Jev guard's last failure, when its last answer was not a real one. Every flag it saw went to an investigation. */
  guardFailure: z.object({ code: WardenGuardFailureCodeSchema, at: InstantSchema }).optional(),
  /** Set while the guard is backing off after a rate limit or an overload: flags go straight to investigation. */
  guardBackoffUntil: InstantSchema.optional(),
});
export type WardenTriageStatus = z.infer<typeof WardenTriageStatusSchema>;

/** A UTC calendar day, `YYYY-MM-DD`: the day every cap counts against. */
export const WardenSpendDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const WardenSpendSchema = z.object({
  day: WardenSpendDaySchema,
  jevUsd: NonNegativeFiniteSchema,
  jevCapUsd: NonNegativeFiniteSchema,
  /** Known investigation spend. An investigation whose cost is not priced yet is counted in `pendingInvestigations`. */
  investigationUsd: NonNegativeFiniteSchema,
  investigationCapUsd: NonNegativeFiniteSchema,
  pendingInvestigations: NonNegativeIntegerSchema,
  capHit: z.enum(['jev', 'investigation']).optional(),
  investigationsLastHour: NonNegativeIntegerSchema,
  maxInvestigationsPerHour: PositiveIntegerSchema,
});
export type WardenSpend = z.infer<typeof WardenSpendSchema>;

/** Today's flags and what became of them — the savings line. */
export const WardenSavingsSchema = z.object({
  day: WardenSpendDaySchema,
  flags: NonNegativeIntegerSchema,
  jevDecisions: NonNegativeIntegerSchema,
  jevSkips: NonNegativeIntegerSchema,
  investigations: NonNegativeIntegerSchema,
  /** The average priced investigation, when at least one has been priced. Never a guess. */
  averageInvestigationUsd: NonNegativeFiniteSchema.optional(),
  /** Skips × the average investigation, minus Jev's own cost. Absent when no investigation was ever priced. */
  savedUsd: NonNegativeFiniteSchema.optional(),
});
export type WardenSavings = z.infer<typeof WardenSavingsSchema>;

export const WardenInvestigationStateSchema = z.enum(['queued', 'running', 'done']);
export type WardenInvestigationState = z.infer<typeof WardenInvestigationStateSchema>;

/** Who sent a flag to an investigation. */
export const WardenInvestigationOriginSchema = z.enum(['sweep', 'jev', 'owner']);
export type WardenInvestigationOrigin = z.infer<typeof WardenInvestigationOriginSchema>;

export const WardenInvestigationSchema = z.object({
  /** The investigating warden's session id, or `queued:<target>` while it waits for a slot. */
  id: z.string().min(1),
  state: WardenInvestigationStateSchema,
  /** `session` investigates one ferret; `fleet` triages several flags in one report. */
  scope: z.enum(['session', 'fleet']),
  origin: WardenInvestigationOriginSchema,
  targetSession: z.string().min(1).optional(),
  anomalyKind: WardenAnomalyKindSchema.optional(),
  wardenSession: z.string().min(1).optional(),
  queuedAt: InstantSchema.optional(),
  startedAt: InstantSchema.optional(),
  finishedAt: InstantSchema.optional(),
  reportPath: z.string().min(1).optional(),
  verdict: WardenVerdictKindSchema.optional(),
  /** Priced from the warden's own transcript once analytics has read it. */
  costUsd: NonNegativeFiniteSchema.optional(),
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
export type WardenInvestigation = z.infer<typeof WardenInvestigationSchema>;

export const WardenActionKindSchema = z.enum(['bless', 'nudge', 'resume', 'stop', 'failover']);
export type WardenActionKind = z.infer<typeof WardenActionKindSchema>;

/**
 * `done` it happened; `held` the verdict asked for it and the owner has not let the Warden do it alone,
 * so it waits for the owner; `failed` it was attempted and did not take.
 */
export const WardenActionOutcomeSchema = z.enum(['done', 'held', 'failed']);
export type WardenActionOutcome = z.infer<typeof WardenActionOutcomeSchema>;

export const WardenActionSchema = z.object({
  at: InstantSchema,
  sessionId: z.string().min(1),
  action: WardenActionKindSchema,
  outcome: WardenActionOutcomeSchema,
  /** `jev` only ever blesses. Every other action is an investigation's verdict. */
  by: z.enum(['jev', 'warden']),
  anomalyKind: WardenAnomalyKindSchema.optional(),
  /** One plain sentence: what happened and why. */
  detail: z.string().min(1),
  reportPath: z.string().min(1).optional(),
  /** Jev's confidence in a skip. */
  confidence: z.number().min(0).max(1).optional(),
  /** The account a failover moved to. */
  agent: z.string().min(1).optional(),
});
export type WardenAction = z.infer<typeof WardenActionSchema>;

export const WardenBlessingViewSchema = z.object({
  sessionId: z.string().min(1),
  kinds: z.array(WardenAnomalyKindSchema),
  expiresAt: InstantSchema,
  by: z.enum(['jev', 'warden']),
});
export type WardenBlessingView = z.infer<typeof WardenBlessingViewSchema>;

export const WardenStatusViewSchema = z.object({
  config: WardenConfigSchema,
  lastSweepAt: InstantSchema.optional(),
  /** When the timer is next due. Absent until the timer is armed. */
  nextSweepAt: InstantSchema.optional(),
  anomalies: z.array(WardenAnomalySchema),
  fingerprint: z.string(),
  liveWarden: z.string().optional(),
  lastSpawnAt: InstantSchema.optional(),
  lastReport: z.object({ reportId: z.string().min(1), head: z.string() }).optional(),
  failover: WardenFailoverStatusSchema.optional(),
  triage: WardenTriageStatusSchema,
  spend: WardenSpendSchema,
  savings: WardenSavingsSchema,
  /** Queued, running and recently finished investigations, newest first. */
  investigations: z.array(WardenInvestigationSchema),
  /** What the Warden did, or was told to do and waits on the owner for, newest first. */
  actions: z.array(WardenActionSchema),
  blessings: z.array(WardenBlessingViewSchema),
});
export type WardenStatusView = z.infer<typeof WardenStatusViewSchema>;

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

// ── Manual investigation ────────────────────────────────────────────────────────────────────────

export const WARDEN_INVESTIGATE_PATH = '/v1/warden/investigate';

/**
 * The owner asking for an investigation of one ferret. It skips Jev and the blessing — the owner has
 * already decided it is worth a look — and still waits for a free slot and counts against today's cap.
 */
export const WardenInvestigateRequestSchema = z.strictObject({
  sessionId: z.string().trim().min(1),
  /** What the investigator should look at, in the owner's words. */
  note: z.string().trim().min(1).max(500).optional(),
});
export type WardenInvestigateRequest = z.infer<typeof WardenInvestigateRequestSchema>;

export const WardenInvestigateViewSchema = z.object({
  sessionId: z.string().min(1),
  state: z.enum(['queued', 'running']),
  /** Place in the queue, 1 being next. Absent once it runs. */
  position: PositiveIntegerSchema.optional(),
  wardenSession: z.string().min(1).optional(),
  message: z.string().min(1),
});
export type WardenInvestigateView = z.infer<typeof WardenInvestigateViewSchema>;

// ── Who needs you ───────────────────────────────────────────────────────────────────────────────

export const WARDEN_ATTENTION_PATH = '/v1/warden/attention';

export const WardenJudgementStateSchema = z.enum(['judged', 'pending', 'queued', 'failed', 'none']);
export type WardenJudgementState = z.infer<typeof WardenJudgementStateSchema>;

export const WardenJudgeProvenanceSchema = z.object({
  wardenSessionId: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  harness: z.string().optional(),
});
export type WardenJudgeProvenance = z.infer<typeof WardenJudgeProvenanceSchema>;

export const WardenJudgementSchema = z.object({
  state: WardenJudgementStateSchema,
  verdict: WardenVerdictKindSchema.optional(),
  reason: z.string().min(1),
  judgedBy: WardenJudgeProvenanceSchema.optional(),
  at: InstantSchema.optional(),
  reportPath: z.string().min(1).optional(),
  recommendation: WardenRecommendationSchema.optional(),
  stale: z.boolean().optional(),
});
export type WardenJudgement = z.infer<typeof WardenJudgementSchema>;

export const FleetAttentionItemSchema = z.object({
  sessionId: z.string().min(1),
  teammate: z.string().optional(),
  label: z.string().optional(),
  sessionStatus: SessionStatusSchema.optional(),
  id: z.string().min(1),
  source: z.enum(['task', 'question', 'agent-raised', 'warden-anomaly', 'warden-action']),
  subject: z.string(),
  why: z.string(),
  context: z.string().optional(),
  waitingSince: InstantSchema,
  howToResolve: z.string(),
  recommendation: WardenRecommendationSchema.optional(),
  raisedBy: z.enum(['human', 'agent', 'daemon']).optional(),
  raisedByName: z.string().optional(),
  judgement: WardenJudgementSchema.optional(),
  fromAnomaly: z.boolean().optional(),
  provider: z.string().optional(),
  anomalyKind: WardenAnomalyKindSchema.optional(),
});
export type FleetAttentionItem = z.infer<typeof FleetAttentionItemSchema>;

export const WardenAttentionOutcomeSchema = z.enum(['items', 'clean-sweep', 'degraded', 'no-sweep']);
export type WardenAttentionOutcome = z.infer<typeof WardenAttentionOutcomeSchema>;

/**
 * Every ferret that needs the owner, and why: the session attention boards joined with the Warden's
 * verdicts, the flags nothing has judged, and the actions a verdict asked for that wait on the owner.
 * The four outcomes never collapse: an unreadable board is `degraded`, not an all-clear.
 */
export const WardenAttentionViewSchema = z.object({
  generatedAt: InstantSchema,
  lastSweepAt: InstantSchema.optional(),
  outcome: WardenAttentionOutcomeSchema,
  wardenDegraded: z.object({ since: InstantSchema.optional(), reason: z.string().min(1) }).optional(),
  items: z.array(FleetAttentionItemSchema),
  boardsWithParseErrors: z.array(z.object({ sessionId: z.string().min(1), parseErrors: PositiveIntegerSchema })),
  verdictCoverage: z.object({ limit: PositiveIntegerSchema, truncated: z.boolean() }),
});
export type WardenAttentionView = z.infer<typeof WardenAttentionViewSchema>;
