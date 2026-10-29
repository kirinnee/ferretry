import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { SessionStatusSchema } from './session.ts';

/**
 * THE WARDEN WIRE — the supervisor that watches every ferret, and everything a client reads or sends
 * about it: its settings, its status, the "who needs you" feed and the owner's manual requests.
 *
 * LAYERS, AND ONLY ONE OF THEM ACTS. Free deterministic RULES flag anomalies whenever the Warden is on.
 * Two optional layers decide what becomes of a flag: JEV — TypeSafe AI's cheap decision model — clears
 * the flags it is confident about, and an LLM INVESTIGATION by an assigned warden looks at the rest.
 * JEV IS THE FIRST RESPONDER: it answers `leave` (healthy: bless the anomaly for a while), one act —
 * `nudge`, `resume`, `restart`, `failover`, `stop` — or `unsure`. An act is carried out only when
 * Jev is at least as sure as the owner's threshold for THAT act ({@link WardenJevActsSchema}) and the
 * owner lets the Warden do it alone; everything else — unsure, not sure enough, not allowed alone, any
 * failure, or a second act on a situation Jev already acted on — goes to an investigation when that
 * layer is on, and to the owner when it is off. An investigation's verdict acts the same way, through
 * the same remedies, filtered by the same `mayActAlone`; stop is never on that list unless the owner
 * put it there.
 *
 * A CLEARED FLAG IS LEFT ALONE FOR A WHILE, and each consecutive re-clear doubles the while, up to four
 * hours; the owner can leave a ferret alone for longer still.
 *
 * SPEND IS CAPPED PER UTC DAY, per layer. A cap that is hit turns off only its own layer until
 * midnight, and the status says so: no unattended spend by surprise.
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
 * The two triage LAYERS a flag can pass through after the free rules have raised it. Rules are not a
 * layer here because they cannot be switched off: whenever the Warden is on, its rules flag and spend
 * nothing. Each layer is its own opt-in with its own daily cap:
 *
 * - `jev` — Jev, TypeSafe AI's cheap decision model, looks at a flag first. A confident "healthy"
 *   clears it; anything else passes it on.
 * - `llm` — a full investigation by an assigned warden, rotated across the configured logins.
 *
 * A flag Jev did not clear goes to an investigation when `llm` is on, and to the owner when it is off —
 * never to a spawn the owner did not switch on. Both off is the default: rules only, nothing spent.
 */
export const WardenLayersSchema = z.object({
  jev: z.boolean(),
  llm: z.boolean(),
});
export type WardenLayers = z.infer<typeof WardenLayersSchema>;
export type WardenLayer = keyof WardenLayers;

/**
 * The single `triage` choice the layers replaced, as an older `warden.yaml` or daemon still says it.
 * Read, never written: `rules` was both layers off, `llm` an investigation of every flag, and `jev` the
 * guard in front of an investigation — both on.
 */
export const LegacyWardenTriageSchema = z.enum(['rules', 'llm', 'jev']);
export type LegacyWardenTriage = z.infer<typeof LegacyWardenTriageSchema>;

export const LEGACY_TRIAGE_LAYERS: Readonly<Record<LegacyWardenTriage, WardenLayers>> = {
  rules: { jev: false, llm: false },
  llm: { jev: false, llm: true },
  jev: { jev: true, llm: true },
};

/**
 * A settings document from before a setting existed, restated in today's terms. TOLERANT ON READ:
 *
 * - a legacy `triage` becomes `layers`; an explicit `layers` wins over it field by field, and an
 *   unrecognised `triage` is left for the schema to refuse;
 * - a whole `mayActAlone` with no `closeLeftovers` takes its default, on;
 * - a `mayActAlone` with no `restart` takes the owner's `resume` answer, because a restart is a resume
 *   that relaunches the agent: what the owner let the Warden do to a dead turn, it may do to a dead or
 *   frozen agent;
 * - a whole document with no `jevActs` takes {@link DEFAULT_WARDEN_JEV_ACTS}, so settings from before
 *   Jev could act still read (a partial file is filled by the file loader's merge instead).
 *
 * Anything that is not an object passes through untouched.
 */
export function migrateLegacyWardenSettings(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return withJevActs(withCloseLeftovers(withRestart(withLayers(value as Record<string, unknown>))));
}

/** A whole document from before Jev could act takes the default bars. A partial one is left to its merge. */
function withJevActs(value: Record<string, unknown>): Record<string, unknown> {
  if ('jevActs' in value || !('mayActAlone' in value) || !('guard' in value)) return value;
  return { ...value, jevActs: DEFAULT_WARDEN_JEV_ACTS };
}

function withLayers(value: Record<string, unknown>): Record<string, unknown> {
  if (!('triage' in value)) return value;
  const { triage, ...rest } = value;
  const legacy = LegacyWardenTriageSchema.safeParse(triage);
  if (!legacy.success) return value;
  const stated = rest.layers;
  return {
    ...rest,
    layers: {
      ...LEGACY_TRIAGE_LAYERS[legacy.data],
      ...(typeof stated === 'object' && stated !== null ? stated : {}),
    },
  };
}

function withRestart(value: Record<string, unknown>): Record<string, unknown> {
  const acts = value.mayActAlone;
  if (typeof acts !== 'object' || acts === null || 'restart' in acts || !('resume' in acts)) return value;
  return { ...value, mayActAlone: { ...acts, restart: (acts as { readonly resume: unknown }).resume } };
}

/** A whole `mayActAlone` from before leftover cleanup existed takes its default, on. */
function withCloseLeftovers(value: Record<string, unknown>): Record<string, unknown> {
  const acts = value.mayActAlone;
  if (typeof acts !== 'object' || acts === null || 'closeLeftovers' in acts || !('stop' in acts)) return value;
  return { ...value, mayActAlone: { ...acts, closeLeftovers: true } };
}

/** The sweep cadences a person can pick. The sweep itself is free; only what a flag leads to costs. */
export const WARDEN_SWEEP_INTERVALS = [1, 2, 5, 10, 15] as const;
export const WardenSweepIntervalSchema = z.literal(WARDEN_SWEEP_INTERVALS);
export type WardenSweepInterval = z.infer<typeof WardenSweepIntervalSchema>;

/** The leave bar's range: Jev may leave a flag alone only when it is at least this sure. */
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

/**
 * How sure Jev must be to carry out each act ALONE — riskier acts ask for more. Jev may leave a flag at
 * `guard.threshold`; every act here is held to its own, higher, bar. `1` means Jev never does that act
 * alone (the flag goes on to an investigation or to the owner). There is no failover row: Jev cannot
 * name the login to move to, so a failover it recommends always goes on.
 */
export const WARDEN_JEV_ACT_THRESHOLD_RANGE = { min: 0.8, max: 1 } as const;
const JevActThresholdSchema = z
  .number()
  .min(WARDEN_JEV_ACT_THRESHOLD_RANGE.min)
  .max(WARDEN_JEV_ACT_THRESHOLD_RANGE.max);

export const WardenJevActsSchema = z.object({
  nudge: JevActThresholdSchema,
  resume: JevActThresholdSchema,
  restart: JevActThresholdSchema,
  stop: JevActThresholdSchema,
});
export type WardenJevActs = z.infer<typeof WardenJevActsSchema>;
export type WardenJevAct = keyof WardenJevActs;

/** The bars a new machine — or a settings document from before they existed — holds Jev to. */
export const DEFAULT_WARDEN_JEV_ACTS: WardenJevActs = { nudge: 0.9, resume: 0.93, restart: 0.95, stop: 0.98 };

/**
 * What an investigation's verdict — or Jev, when it is sure enough — may do without asking. `stop` is off unless the owner turns it on.
 * `restart` relaunches a dead or frozen process with its conversation intact; it defaults to whatever
 * the owner said about `resume`.
 */
export const WardenMayActAloneSchema = z.object({
  nudge: z.boolean(),
  resume: z.boolean(),
  restart: z.boolean(),
  failover: z.boolean(),
  stop: z.boolean(),
  /**
   * Close a browser a finished ferret left running under its pane — by rule, with no investigation.
   * Defaults to on: it acts on nothing but an idle leftover, and the ferret itself is never touched.
   */
  closeLeftovers: z.boolean(),
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

/**
 * The investigation's own knobs. Its login and model are `accounts[0]`, the head of the failover list —
 * or, when `accounts` is empty, this machine's default runtime (see {@link WardenLoginSchema}).
 */
export const WardenInvestigationConfigSchema = z.object({
  effort: WardenEffortSchema,
});
export type WardenInvestigationConfig = z.infer<typeof WardenInvestigationConfigSchema>;

const WardenConfigShape = z.object({
  enabled: z.boolean(),
  layers: WardenLayersSchema,
  guard: WardenGuardConfigSchema,
  caps: WardenCapsSchema,
  mayActAlone: WardenMayActAloneSchema,
  /** How sure Jev must be to do each act alone. */
  jevActs: WardenJevActsSchema,
  events: WardenEventTriggersSchema,
  investigation: WardenInvestigationConfigSchema,
  /** The owner's failover order. EMPTY means "not chosen": the machine's default runtime, resolved at read time. */
  accounts: z.array(WardenAccountSchema),
  failover: WardenFailoverConfigSchema,
  providerOutage: ProviderOutageConfigSchema,
  intervalMinutes: WardenSweepIntervalSchema,
  unattendedMinutes: PositiveIntegerSchema,
  minSpawnGapMinutes: NonNegativeIntegerSchema,
  susThinkingSeconds: PositiveIntegerSchema,
  susSubprocessSeconds: PositiveIntegerSchema,
  maxAssignedWardens: PositiveIntegerSchema,
  assignedCooldownMinutes: NonNegativeIntegerSchema,
  /** How long a cleared flag is left alone the first time. Each consecutive re-clear doubles it, up to {@link WARDEN_BLESSING_CEILING_MINUTES}. */
  blessMinutes: NonNegativeIntegerSchema,
});

/**
 * The Warden settings. A document still carrying the legacy `triage` is read as its `layers`
 * ({@link migrateLegacyWardenSettings}); nothing ever writes `triage` again.
 */
export const WardenConfigSchema = z.preprocess(migrateLegacyWardenSettings, WardenConfigShape);
export type WardenConfig = z.infer<typeof WardenConfigShape>;

/** The longest a run of re-clears can leave a flag alone: four hours. */
export const WARDEN_BLESSING_CEILING_MINUTES = 240;

export const WardenConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  layers: WardenLayersSchema.strict().partial().optional(),
  guard: WardenGuardConfigSchema.strict().partial().optional(),
  caps: WardenCapsSchema.strict().partial().optional(),
  mayActAlone: WardenMayActAloneSchema.strict().partial().optional(),
  jevActs: WardenJevActsSchema.strict().partial().optional(),
  events: WardenEventTriggersSchema.strict().partial().optional(),
  investigation: WardenInvestigationConfigSchema.strict().partial().optional(),
  /** `[]` hands the choice back to the machine's default runtime. */
  accounts: z.array(WardenAccountSchema).optional(),
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
  'layers',
  'guard',
  'caps',
  'mayActAlone',
  'jevActs',
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
  /** The liveness reflex saw no sign of life after a nudge: a restart candidate, never stopped. */
  'agent_frozen',
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
  /** A screen change that is not the harness's own spinner, clock or status line. */
  lastMeaningfulPaneAt: InstantSchema.optional(),
  subprocessSince: InstantSchema.optional(),
  /** Which tool command the current subprocess episode is. */
  subprocessKey: z.string().min(1).optional(),
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
  /** What the anomaly is about (its turn, and for a stuck command which command): the backoff's key. */
  subject: z.string().min(1).optional(),
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

/**
 * Where the investigation's login came from.
 *
 * NO LOGIN IS EVER COMPILED IN. `configured` is the owner's own `accounts`; `machine_default` is the
 * default runtime `machine.yaml` names, read fresh, because the owner never chose one for the Warden;
 * `not_set` is a machine with neither, where LLM triage is unavailable and says so rather than falling
 * back to a name nobody here has.
 */
export const WardenLoginSourceSchema = z.enum(['configured', 'machine_default', 'not_set']);
export type WardenLoginSource = z.infer<typeof WardenLoginSourceSchema>;

export const WardenLoginSchema = z.object({
  source: WardenLoginSourceSchema,
  /**
   * Named logins this machine does not have — a `warden.yaml` written on another machine, say. Shown as
   * "unknown login — choose one" and never used. The owner's file is never rewritten to hide them.
   */
  unknown: z.array(z.string().min(1)),
  /** The logins the Warden could run on here, for the picker. Empty when the inventory is unreadable. */
  available: z.array(z.string().min(1)),
});
export type WardenLogin = z.infer<typeof WardenLoginSchema>;

export const WardenConfigViewSchema = z.object({
  /** As stored: `accounts` may be empty. */
  config: WardenConfigSchema,
  /** The failover order in effect: the stored one, or the machine's default runtime, or none. */
  accounts: z.array(WardenAccountSchema),
  warnings: z.array(z.string()),
  /** Absent from a daemon that predates it, which always had a stored login. */
  login: WardenLoginSchema.optional(),
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
 * Why a layer in effect is not the one configured. `configured` means it is — on or off as the owner
 * set it; every other value switched an ENABLED layer off, and the status line must say so out loud.
 * A cap turns off only its own layer: the Jev cap leaves investigations running, and the investigation
 * cap leaves Jev clearing flags.
 */
export const WardenTriageReasonSchema = z.enum([
  'configured',
  /** The Warden is off: nothing is triaged and nothing is spent. */
  'disabled',
  /** Today's Jev spend reached its cap: Jev is off until midnight UTC. */
  'jev_cap',
  /** Today's investigation spend reached its cap: investigations are off until midnight UTC. */
  'investigation_cap',
  /** No usable investigation login: none was chosen and the machine has no default runtime, or every one named is unknown here. */
  'no_login',
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

/** One layer: what the owner set, whether it runs right now, and why not when it does not. */
export const WardenLayerStatusSchema = z.object({
  configured: z.boolean(),
  active: z.boolean(),
  reason: WardenTriageReasonSchema,
});
export type WardenLayerStatus = z.infer<typeof WardenLayerStatusSchema>;

/**
 * A daemon from before the layers answered one `{configured, effective, reason}` triage. Read as the
 * two layers it meant, so a newer browser can still show an older machine.
 */
function migrateLegacyTriageStatus(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('effective' in value)) return value;
  const { configured, effective, reason, ...rest } = value as Record<string, unknown>;
  const was = LegacyWardenTriageSchema.safeParse(configured);
  const is = LegacyWardenTriageSchema.safeParse(effective);
  if (!was.success || !is.success) return value;
  const layer = (name: WardenLayer): WardenLayerStatus => {
    const on = LEGACY_TRIAGE_LAYERS[was.data][name];
    const active = LEGACY_TRIAGE_LAYERS[is.data][name];
    return { configured: on, active, reason: on === active ? 'configured' : (reason as WardenTriageReason) };
  };
  return { ...rest, jev: layer('jev'), llm: layer('llm') };
}

export const WardenTriageStatusSchema = z.preprocess(
  migrateLegacyTriageStatus,
  z.object({
    jev: WardenLayerStatusSchema,
    llm: WardenLayerStatusSchema,
    /** The Jev guard's last failure, when its last answer was not a real one. Every flag it saw was passed on. */
    guardFailure: z.object({ code: WardenGuardFailureCodeSchema, at: InstantSchema }).optional(),
    /** Set while the guard is backing off after a rate limit or an overload: flags are passed on without asking. */
    guardBackoffUntil: InstantSchema.optional(),
  }),
);
export type WardenTriageStatus = z.infer<typeof WardenTriageStatusSchema>;

/** A UTC calendar day, `YYYY-MM-DD`: the day every cap counts against. */
export const WardenSpendDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const WardenCapSchema = z.enum(['jev', 'investigation']);
export type WardenCap = z.infer<typeof WardenCapSchema>;

/** An older daemon named at most one cap it hit; read as the list it was. */
function migrateLegacyCapHit(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || 'capsHit' in value) return value;
  const { capHit, ...rest } = value as Record<string, unknown>;
  return { ...rest, capsHit: capHit === undefined ? [] : [capHit] };
}

export const WardenSpendSchema = z.preprocess(
  migrateLegacyCapHit,
  z.object({
    day: WardenSpendDaySchema,
    jevUsd: NonNegativeFiniteSchema,
    jevCapUsd: NonNegativeFiniteSchema,
    /** Known investigation spend. An investigation whose cost is not priced yet is counted in `pendingInvestigations`. */
    investigationUsd: NonNegativeFiniteSchema,
    investigationCapUsd: NonNegativeFiniteSchema,
    pendingInvestigations: NonNegativeIntegerSchema,
    /** Every cap today's spend reached. Each one turns off only its own layer. */
    capsHit: z.array(WardenCapSchema),
    /**
     * The caps in `capsHit` reached only for THIS UTC hour: a layer may spend at most a quarter of its
     * day in any one hour, so one burst cannot burn the day. Such a layer is back at `pacedUntil`, not at
     * midnight. Absent from a daemon that predates pacing, and when nothing is paced.
     */
    capsPaced: z.array(WardenCapSchema).optional(),
    /** The top of the next UTC hour, when `capsPaced` is not empty. */
    pacedUntil: InstantSchema.optional(),
    investigationsLastHour: NonNegativeIntegerSchema,
    maxInvestigationsPerHour: PositiveIntegerSchema,
  }),
);
export type WardenSpend = z.infer<typeof WardenSpendSchema>;

/** Today's flags and what became of them — the savings line. */
export const WardenSavingsSchema = z.object({
  day: WardenSpendDaySchema,
  flags: NonNegativeIntegerSchema,
  jevDecisions: NonNegativeIntegerSchema,
  jevSkips: NonNegativeIntegerSchema,
  /** Flags Jev settled by acting alone — a nudge, a resume, a restart or a stop — instead of an investigation. Absent from an older daemon. */
  jevActions: NonNegativeIntegerSchema.optional(),
  investigations: NonNegativeIntegerSchema,
  /** The average priced investigation, when at least one has been priced. Never a guess. */
  averageInvestigationUsd: NonNegativeFiniteSchema.optional(),
  /** (Skips + Jev's own actions) × the average investigation, minus Jev's own cost. Absent when no investigation was ever priced. */
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

/** Who cleared a flag: an investigation, Jev's confident skip, or the owner leaving it alone. */
export const WardenClearedBySchema = z.enum(['jev', 'warden', 'owner']);
export type WardenClearedBy = z.infer<typeof WardenClearedBySchema>;

export const WardenActionKindSchema = z.enum([
  'bless',
  'nudge',
  'resume',
  'restart',
  'stop',
  'failover',
  /** A browser a finished ferret left running, closed by rule — no investigation was involved. */
  'close_leftover',
]);
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
  /**
   * `warden` is an investigation's verdict or a rule; `jev` is Jev acting as first responder (a
   * bless, or an act it was sure enough about); `owner` is the owner — Leave it longer, or an answer on
   * a Warden card carried out by the Warden.
   */
  by: WardenClearedBySchema,
  anomalyKind: WardenAnomalyKindSchema.optional(),
  /** One plain sentence: what happened and why. */
  detail: z.string().min(1),
  reportPath: z.string().min(1).optional(),
  /** Jev's confidence in what it chose. Present exactly on Jev's own actions. */
  confidence: z.number().min(0).max(1).optional(),
  /** Why, in the words of the option Jev chose. Jev's actions only: an investigation's reason is in its report. */
  reason: z.string().min(1).max(500).optional(),
  /** The account a failover moved to. */
  agent: z.string().min(1).optional(),
});
export type WardenAction = z.infer<typeof WardenActionSchema>;

export const WardenBlessingViewSchema = z.object({
  sessionId: z.string().min(1),
  kinds: z.array(WardenAnomalyKindSchema),
  expiresAt: InstantSchema,
  by: WardenClearedBySchema,
  /**
   * How many times in a row these flags were cleared before this one, while the ferret held its status.
   * Each re-clear doubles how long the flag is left alone. Absent on a first clear.
   */
  streak: PositiveIntegerSchema.optional(),
  /** The owner asked to leave it alone until its status changes, rather than for a while. */
  untilChange: z.literal(true).optional(),
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
  /** Where the investigation's login came from. Absent from a daemon that predates it. */
  login: WardenLoginSchema.optional(),
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

// ── Leave it longer ─────────────────────────────────────────────────────────────────────────────

export const WARDEN_LEAVE_PATH = '/v1/warden/leave';

/** How long the owner can leave a ferret's flags alone: an hour, four, or until its status changes. */
export const WARDEN_LEAVE_DURATIONS = ['1h', '4h', 'until_change'] as const;
export const WardenLeaveDurationSchema = z.enum(WARDEN_LEAVE_DURATIONS);
export type WardenLeaveDuration = z.infer<typeof WardenLeaveDurationSchema>;

/**
 * The owner leaving a flagged or cleared ferret alone for longer than the Warden would. NARROW like
 * every blessing: it covers the kinds flagged or cleared on that ferret now, so a new kind of trouble
 * still raises a flag, and any change of status ends it. `until_change` is bounded at a week.
 */
export const WardenLeaveRequestSchema = z.strictObject({
  sessionId: z.string().trim().min(1),
  duration: WardenLeaveDurationSchema,
});
export type WardenLeaveRequest = z.infer<typeof WardenLeaveRequestSchema>;

export const WardenLeaveViewSchema = z.object({
  blessing: WardenBlessingViewSchema,
  message: z.string().min(1),
});
export type WardenLeaveView = z.infer<typeof WardenLeaveViewSchema>;

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
 * What the Warden needs the owner for: its own open Attention cards (`raisedBy: daemon`, a `warden:`
 * source reference), read back from every live ferret's board — the same items the unified Attention
 * inbox shows, never a second list. `warden-anomaly` and `warden-action` rows are no longer sent; the
 * enum keeps them so an app reads an older machine. The four outcomes never collapse: an unreadable
 * board is `degraded`, not an all-clear.
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
