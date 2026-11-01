import { z } from 'zod';
import { TaskRefSchema } from './board-refs.ts';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { SessionStatusSchema } from './session.ts';
import {
  nextSystemCallsignSequence,
  SYSTEM_CALLSIGN_MAX_SEQUENCE,
  systemCallsignName,
  systemCallsignSequence,
} from './system-callsigns.ts';

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
export const WARDEN_GUARD_THRESHOLD_RANGE = { min: 0.3, max: 0.95 } as const;

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
 * How sure Jev must be to carry out each act ALONE. Jev may leave a flag at `guard.threshold`; every
 * act here is held to its own bar — by default the same as the leave bar, except a stop, a notch higher
 * because it is the most disruptive. `1` means Jev never does that act alone (the flag goes on to an investigation or to the owner). There is no failover row: Jev cannot
 * name the login to move to, so a failover it recommends always goes on.
 */
export const WARDEN_JEV_ACT_THRESHOLD_RANGE = { min: 0.3, max: 1 } as const;
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
export const DEFAULT_WARDEN_JEV_ACTS: WardenJevActs = { nudge: 0.7, resume: 0.7, restart: 0.7, stop: 0.8 };

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

/** Recovery bounds are independent of investigation budgets: no model judges a recorded exit. */
export const WardenReviveConfigSchema = z.object({
  enabled: z.boolean(),
  windowMinutes: PositiveIntegerSchema,
  cooldownMinutes: PositiveIntegerSchema,
  waveSize: z.number().int().min(1).max(3),
  waveGapSeconds: z.number().int().min(10),
  breakerMinutes: PositiveIntegerSchema,
});
export type WardenReviveConfig = z.infer<typeof WardenReviveConfigSchema>;
export const DEFAULT_WARDEN_REVIVE = {
  enabled: true,
  windowMinutes: 15,
  cooldownMinutes: 30,
  waveSize: 3,
  waveGapSeconds: 10,
  breakerMinutes: 30,
};

/**
 * What can make the Warden move a ferret to another login on its own (`autoMigrate.when`):
 * `rate_limited` its login hit a usage limit and the ferret sits waiting for it to reset;
 * `budget_exceeded` its login passed its hard spend budget on this machine, which would otherwise stop it.
 */
export const WARDEN_AUTO_MIGRATE_TRIGGERS = ['rate_limited', 'budget_exceeded'] as const;
export const WardenAutoMigrateTriggerSchema = z.enum(WARDEN_AUTO_MIGRATE_TRIGGERS);
export type WardenAutoMigrateTrigger = z.infer<typeof WardenAutoMigrateTriggerSchema>;

/** How long the Warden waits for a ferret to stop its own background jobs, in minutes. */
export const WARDEN_AUTO_MIGRATE_WAIT_RANGE = { min: 1, max: 60 } as const;
/** How many times one ferret may be moved in an hour. */
export const WARDEN_AUTO_MIGRATE_MOVES_RANGE = { min: 1, max: 6 } as const;
/** How much of its tightest window a login must have left to be moved onto, in percent. 0 turns the floor off. */
export const WARDEN_AUTO_MIGRATE_HEADROOM_RANGE = { min: 0, max: 90 } as const;
/** At least this share left: a login 99% used is not a place to move a ferret that just ran dry. */
export const DEFAULT_WARDEN_MIN_HEADROOM_PERCENT = 20;

/**
 * MOVING A FERRET THAT HIT A LIMIT. Off by default. When on, a ferret whose login is out of quota (or past its
 * hard budget) is moved — same session, same chat, same card — to another login of the SAME harness that is
 * ready, signed in, not switched off and under its own quota and budget. `targets` empty means "any such login
 * of the same provider, most headroom first"; a list is the owner's order, and the only way a move crosses to
 * another provider. A login with less than `minHeadroomPercent` of its tightest window left is never moved onto,
 * so a move does not just hand the ferret to the next login about to run dry. A ferret with background jobs is asked to stop them and given `waitMinutes`; with
 * `forceStopBackground` the Warden stops the jobs under that ferret's own pane itself instead. Switching it on,
 * switching force-stop on, adding a trigger or a target, raising `maxMovesPerHour` or lowering
 * `minHeadroomPercent` waits for the owner.
 */
const WardenAutoMigrateHeadroomSchema = z
  .number()
  .int()
  .min(WARDEN_AUTO_MIGRATE_HEADROOM_RANGE.min)
  .max(WARDEN_AUTO_MIGRATE_HEADROOM_RANGE.max);
const WardenAutoMigrateShape = {
  enabled: z.boolean(),
  when: z.array(WardenAutoMigrateTriggerSchema),
  /** Runtime names, in the owner's order. Empty: any ready login of the same harness and provider. */
  targets: z.array(z.string().trim().min(1)),
  forceStopBackground: z.boolean(),
  waitMinutes: z.number().int().min(WARDEN_AUTO_MIGRATE_WAIT_RANGE.min).max(WARDEN_AUTO_MIGRATE_WAIT_RANGE.max),
  maxMovesPerHour: z.number().int().min(WARDEN_AUTO_MIGRATE_MOVES_RANGE.min).max(WARDEN_AUTO_MIGRATE_MOVES_RANGE.max),
};
export const WardenAutoMigrateConfigSchema = z.object({
  ...WardenAutoMigrateShape,
  /** The share of its tightest window a target login must have left. A document written before this existed reads as the default. */
  minHeadroomPercent: WardenAutoMigrateHeadroomSchema.default(DEFAULT_WARDEN_MIN_HEADROOM_PERCENT),
});
/** A change to the document. The default belongs to a whole document: a patch that omits the floor leaves the saved one alone. */
const WardenAutoMigratePatchSchema = z
  .strictObject({ ...WardenAutoMigrateShape, minHeadroomPercent: WardenAutoMigrateHeadroomSchema })
  .partial();
export type WardenAutoMigrateConfig = z.infer<typeof WardenAutoMigrateConfigSchema>;
export const DEFAULT_WARDEN_AUTO_MIGRATE: WardenAutoMigrateConfig = {
  enabled: false,
  when: ['rate_limited', 'budget_exceeded'],
  targets: [],
  forceStopBackground: false,
  waitMinutes: 10,
  maxMovesPerHour: 1,
  minHeadroomPercent: DEFAULT_WARDEN_MIN_HEADROOM_PERCENT,
};
const WardenConfigShape = z.object({
  enabled: z.boolean(),
  revive: WardenReviveConfigSchema.default(DEFAULT_WARDEN_REVIVE),
  /** Moving a ferret that hit a limit to another login ({@link WardenAutoMigrateConfigSchema}). */
  autoMigrate: WardenAutoMigrateConfigSchema.default(DEFAULT_WARDEN_AUTO_MIGRATE),
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
  revive: WardenReviveConfigSchema.strict().partial().optional(),
  autoMigrate: WardenAutoMigratePatchSchema.optional(),
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
  'revive',
  'autoMigrate',
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
  /**
   * A card in an active or review lane whose ferret is finished and with nothing alive under it
   * (`board-design.md` §3.3). Its `sessionId` is that ferret, its `task` the card.
   */
  'orphaned_card',
  /**
   * A sub-ferret whose parent's last message it has not answered, with its turn ended this long
   * (`report-overdue.ts`). Its `sessionId` is the sub-ferret.
   */
  'report_overdue',
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
  /** The board card the anomaly is about, for a kind about a card (`orphaned_card`). */
  task: TaskRefSchema.optional(),
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
  /** The investigator's name, `warden-0007`. Absent while queued, and from an older daemon. */
  wardenName: z.string().min(1).optional(),
  /** What Jev did about this flag first. Session investigations only; absent from an older daemon. */
  jev: z.lazy(() => WardenJevBeforeSchema).optional(),
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
  'revive',
]);
export type WardenActionKind = z.infer<typeof WardenActionKindSchema>;

/**
 * `done` it happened; `held` the verdict asked for it and the owner has not let the Warden do it alone,
 * so it waits for the owner; `failed` it was attempted and did not take.
 */
export const WardenActionOutcomeSchema = z.enum(['done', 'held', 'failed']);
export type WardenActionOutcome = z.infer<typeof WardenActionOutcomeSchema>;

/**
 * Who acted on a flag. `auto` is a rule — no model was asked; `jev` is Jev, the cheap first responder;
 * `llm` is an LLM investigation's verdict; `owner` is the owner (Leave it longer, an answer on a card).
 */
export const WardenActorSchema = z.enum(['auto', 'jev', 'llm', 'owner']);
export type WardenActor = z.infer<typeof WardenActorSchema>;

/**
 * What became of a flag, as the Warden's stats count it. `moved` a stuck ferret got going (a nudge,
 * resume, restart or failover); `cleared` it was judged healthy and left alone; `stopped` it was
 * stopped; `asked` the Warden handed it to the owner.
 */
export const WardenOutcomeSchema = z.enum(['moved', 'cleared', 'stopped', 'asked']);
export type WardenOutcome = z.infer<typeof WardenOutcomeSchema>;

export const WardenActionSchema = z.object({
  at: InstantSchema,
  sessionId: z.string().min(1),
  action: WardenActionKindSchema,
  outcome: WardenActionOutcomeSchema,
  /**
   * `warden` is an investigation's verdict or a rule; `jev` is Jev acting as first responder (a
   * bless, or an act it was sure enough about); `owner` only ever blesses (Leave it longer): a Warden
   * notification carries no answers, so the owner never acts through the Warden.
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
  /** The account a move left: a failover the Warden made on its own because a login hit a limit (`autoMigrate`). */
  fromAgent: z.string().min(1).optional(),
  /** Who acted (`WardenActorSchema`). Absent from an older daemon: read it through {@link wardenActionActor}. */
  actor: WardenActorSchema.optional(),
  /** The investigator (`warden-0007`) whose verdict this carried out. Investigation actions only. */
  investigator: z.string().min(1).optional(),
  /** What Jev did about the flag before that investigation. Investigation actions only; absent from an older daemon. */
  jev: z.lazy(() => WardenJevBeforeSchema).optional(),
});
export type WardenAction = z.infer<typeof WardenActionSchema>;

// ── Who acted, and what became of the flag ──────────────────────────────────────────────────────

/**
 * Who acted, for an action from any daemon. A daemon that records `actor` is believed; an older one is
 * read from what it did record: Jev and the owner name themselves, and a `warden` action is an
 * investigation's exactly when it carries that investigation's report — a rule has none.
 */
export function wardenActionActor(action: Pick<WardenAction, 'actor' | 'by' | 'reportPath'>): WardenActor {
  if (action.actor !== undefined) return action.actor;
  if (action.by === 'jev') return 'jev';
  if (action.by === 'owner') return 'owner';
  return action.reportPath === undefined ? 'auto' : 'llm';
}

/**
 * What an action means for the stats, or `undefined` when it counts as none of them: a failed attempt
 * changed nothing, and closing a leftover browser is housekeeping, not a judgement about a ferret.
 * Anything held for the owner is `asked`, whatever it was going to be.
 */
export function wardenActionOutcome(action: Pick<WardenAction, 'action' | 'outcome'>): WardenOutcome | undefined {
  if (action.outcome === 'failed') return undefined;
  if (action.outcome === 'held') return 'asked';
  switch (action.action) {
    case 'bless':
      return 'cleared';
    case 'nudge':
    case 'revive':
    case 'resume':
    case 'restart':
    case 'failover':
      return 'moved';
    case 'stop':
      return 'stopped';
    case 'close_leftover':
      return undefined;
  }
}

/** One outcome's count, split by who acted. `owner` is absent when the owner did none of them. */
export const WardenActorCountsSchema = z.object({
  auto: NonNegativeIntegerSchema,
  jev: NonNegativeIntegerSchema,
  llm: NonNegativeIntegerSchema,
  owner: NonNegativeIntegerSchema.optional(),
});
export type WardenActorCounts = z.infer<typeof WardenActorCountsSchema>;

// ── Every action, by who decided ──────────────────────────────────────────────────────────────────

/**
 * What the action stats count: every {@link WardenActionKindSchema} plus `escalate`, a flag handed to
 * the owner that no held action records (a `NEEDS_HUMAN` verdict, Jev's hand-on, a failed investigation).
 * A revive is the Warden bringing a dead ferret back: `revive` (a rule) and `resume` (a verdict) both are.
 */
export const WardenStatActionSchema = z.enum([...WardenActionKindSchema.options, 'escalate']);
export type WardenStatActionKind = z.infer<typeof WardenStatActionSchema>;

/** The actions that bring a dead or stopped ferret back — what the stats call a revive. */
export const WARDEN_REVIVE_ACTIONS: readonly WardenStatActionKind[] = ['revive', 'resume'];

/**
 * How many times one action had one outcome, split by who decided it (`auto` is a rule, `jev` Jev, `llm`
 * an investigation's verdict, `owner` the owner). One entry per (action, outcome) pair that happened.
 */
export const WardenActionTallySchema = WardenActorCountsSchema.extend({
  action: WardenStatActionSchema,
  outcome: WardenActionOutcomeSchema,
});
export type WardenActionTally = z.infer<typeof WardenActionTallySchema>;

/**
 * What became of the ferrets the Warden brought back, by who decided it: `progressed` the ferret did
 * real work again within {@link WARDEN_REVIVE_PROGRESS_MINUTES}; `stalled` it did not, or it ended again.
 * A revive still inside its window is in neither.
 */
export const WardenReviveResultsSchema = z.object({
  progressed: WardenActorCountsSchema,
  stalled: WardenActorCountsSchema,
});
export type WardenReviveResults = z.infer<typeof WardenReviveResultsSchema>;

/** How long a revived ferret has to show progress before the revive counts as not having taken. */
export const WARDEN_REVIVE_PROGRESS_MINUTES = 10;

// ── Jev's checks ─────────────────────────────────────────────────────────────────────────────

/**
 * What became of one flag Jev was put to. `healthy` it was sure the ferret is fine and the flag was left;
 * `acted` it carried out an act alone; `handed_on` it passed the flag on — to an investigation, or to
 * the owner — because it was not sure enough, the act was the owner's to make, the call failed or the act
 * did not take; `skipped` it was never asked, because its daily cap (or this hour's share of it) was
 * already spent.
 */
export const WardenJevCheckVerdictSchema = z.enum(['healthy', 'acted', 'handed_on', 'skipped']);
export type WardenJevCheckVerdict = z.infer<typeof WardenJevCheckVerdictSchema>;

/** Why Jev handed a flag on, or was not asked. The first nine are the first responder's own reasons. */
export const WardenJevCheckWhySchema = z.enum([
  /** Jev answered `unsure`. */
  'unsure',
  /** Less sure than the bar for what it chose. */
  'not_sure_enough',
  /** The owner's bar for that act is 100%: Jev never does it alone. */
  'never_alone',
  /** The owner has not let the Warden do that act alone. */
  'not_allowed',
  /** A nudge without a message Jev was as sure of. */
  'no_message',
  /** A failover: Jev cannot name the login to move to. */
  'cannot_choose_login',
  /** An act that was not offered for this flag. */
  'not_offered',
  /** No real answer came back: no key, a timeout, a refusal, a back-off, a snapshot that could not be masked. */
  'failed',
  /** Jev already acted on this subject and it is still flagged. */
  'already_acted',
  /** Jev chose an act it was sure enough of, and the act did not take. */
  'act_failed',
  /** `skipped`: today's Jev cap was spent. */
  'jev_cap',
  /** `skipped`: this hour's share of the Jev cap was spent. */
  'jev_paced',
]);
export type WardenJevCheckWhy = z.infer<typeof WardenJevCheckWhySchema>;

/** Where a flag went after Jev handed it on. */
export const WardenJevCheckRouteSchema = z.enum(['investigation', 'owner']);
export type WardenJevCheckRoute = z.infer<typeof WardenJevCheckRouteSchema>;

/** How many steps a Jev path can hold: the decision tree is at most five questions deep, with room to grow. */
export const WARDEN_JEV_PATH_MAX = 12;

/**
 * One question on the path Jev's decision tree took (`daemon/src/lib/warden/jev-tree.ts`): the node, who
 * answered it — the daemon from what it observes (`fact`), or Jev (`judgement`) — the yes or no, and, for
 * Jev's own answers, how sure it was. No text: the node id names the question.
 */
export const WardenJevPathStepSchema = z.object({
  node: z.string().min(1).max(64),
  kind: z.enum(['fact', 'judgement']),
  answer: z.enum(['yes', 'no']),
  /** Jev's confidence in `answer`. Judgements only: a fact is observed, not guessed. */
  confidence: z.number().min(0).max(1).optional(),
});
export type WardenJevPathStep = z.infer<typeof WardenJevPathStepSchema>;

/** The path of one check, root first. */
export const WardenJevPathSchema = z.array(WardenJevPathStepSchema).max(WARDEN_JEV_PATH_MAX);

/**
 * One of Jev's checks, as the Warden keeps it beside its reports: the ferret, the flag, what Jev made of
 * it, how sure it was and what the call cost. Deliberately no text — no reason, no transcript, no screen —
 * so the record can never carry what the vault redactor masked on the way out.
 */
export const WardenJevCheckSchema = z.object({
  at: InstantSchema,
  /** The flagged ferret. */
  sessionId: z.string().min(1),
  /** The flag. */
  anomalyKind: WardenAnomalyKindSchema,
  verdict: WardenJevCheckVerdictSchema,
  /** `acted`: the act carried out. `handed_on`: the act Jev chose and did not carry out alone. */
  act: WardenActionKindSchema.exclude(['bless', 'close_leftover', 'revive']).optional(),
  /** `handed_on` and `skipped`: why. */
  why: WardenJevCheckWhySchema.optional(),
  /** `handed_on` and `skipped`: who looks at it next. */
  route: WardenJevCheckRouteSchema.optional(),
  /** How sure Jev was of what it chose; `0` when it gave no answer. */
  confidence: z.number().min(0).max(1),
  /** What the call cost, in US dollars; `0` when there was none. */
  costUsd: NonNegativeFiniteSchema,
  /** The decision tree's path to the answer, root first. Absent when nothing was walked, or from an older daemon. */
  path: WardenJevPathSchema.optional(),
  /** `not_sure_enough`: the node whose answer was below the bar — the question the owner is asked. */
  node: z.string().min(1).max(64).optional(),
});
export type WardenJevCheck = z.infer<typeof WardenJevCheckSchema>;

/**
 * One UTC day of Jev's checks, counted as each happens. `checks` is every flag Jev was asked about, so
 * `healthy + acted + handedOn = checks`: a flag it was not sure of and handed to an investigation was a
 * check too. `skippedForCap` counts the flags it was NOT asked about because its cap was spent, each once.
 */
export const WardenJevDayStatsSchema = z.object({
  checks: NonNegativeIntegerSchema,
  healthy: NonNegativeIntegerSchema,
  acted: NonNegativeIntegerSchema,
  handedOn: NonNegativeIntegerSchema,
  skippedForCap: NonNegativeIntegerSchema,
});
export type WardenJevDayStats = z.infer<typeof WardenJevDayStatsSchema>;

/**
 * Why Jev did not settle a flag that went on to an investigation, beyond its own check reasons: Jev was
 * not asked because the owner asked for the investigation, a forced run skipped it, the flag is of a kind
 * Jev never judges, it was backing off after a rate limit or an overload, or the snapshot could not be
 * masked — or the investigation started before Jev's checks were kept (`no_record`).
 */
export const WardenJevBeforeWhySchema = z.enum([
  ...WardenJevCheckWhySchema.options,
  'owner_request',
  'forced',
  'not_judgeable',
  'backoff',
  'unredacted',
  'no_record',
]);
export type WardenJevBeforeWhy = z.infer<typeof WardenJevBeforeWhySchema>;

/**
 * What Jev did about a flag before an LLM investigation looked at it — so an investigation is never shown
 * without saying whether Jev ran. `handed_on` Jev checked it and passed it on; `skipped` its cap was
 * spent; `not_asked` it was not put to Jev (`why` says why); `off` the Jev layer is off. For a check,
 * `at` is the check's time: with the ferret and the flag it names the check's line in the Jev check
 * record. No text — never Jev's reason.
 */
export const WardenJevBeforeSchema = z.object({
  verdict: z.enum(['handed_on', 'skipped', 'not_asked', 'off']),
  why: WardenJevBeforeWhySchema.optional(),
  /** The act Jev chose and did not carry out alone. */
  act: WardenJevCheckSchema.shape.act,
  at: InstantSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  costUsd: NonNegativeFiniteSchema.optional(),
  /** The decision tree's path, as the check recorded it. */
  path: WardenJevPathSchema.optional(),
  /** The node Jev was not sure enough of. */
  node: z.string().min(1).max(64).optional(),
});
export type WardenJevBefore = z.infer<typeof WardenJevBeforeSchema>;

/**
 * One UTC day of the Warden's work, rolled up from its persisted state as it happened — never
 * reconstructed from the capped action list, which a busy day overflows.
 */
export const WardenDayStatsSchema = z.object({
  day: WardenSpendDaySchema,
  /** New flags raised. */
  flags: NonNegativeIntegerSchema,
  /** Flags Jev answered (a failed call is not a decision). */
  jevDecisions: NonNegativeIntegerSchema,
  /** LLM investigations started. */
  investigations: NonNegativeIntegerSchema,
  jevUsd: NonNegativeFiniteSchema,
  /** Known investigation spend; an investigation not priced yet adds nothing until it is. */
  investigationUsd: NonNegativeFiniteSchema,
  moved: WardenActorCountsSchema,
  cleared: WardenActorCountsSchema,
  stopped: WardenActorCountsSchema,
  asked: WardenActorCountsSchema,
  /** Jev's checks this day. Absent from an older daemon, which kept only `jevDecisions`. */
  jev: WardenJevDayStatsSchema.optional(),
  /** Every action this day by outcome and decider (revives, nudges, restarts …). Absent from an older daemon. */
  acts: z.array(WardenActionTallySchema).optional(),
  /** What became of the revives this day. Absent from an older daemon. */
  reviveResults: WardenReviveResultsSchema.optional(),
});
export type WardenDayStats = z.infer<typeof WardenDayStatsSchema>;

/** How many days of {@link WardenDayStats} the status carries, today included. */
export const WARDEN_HISTORY_DAYS = 30;

// ── Investigator names ──────────────────────────────────────────────────────────────────────────

/**
 * Every investigator the Warden starts is called `warden-000001`, `warden-000002`, … `warden-FFFFFF`
 * — the shape every system session shares (`system-callsigns.ts`), never a name from the first-name pool.
 */
export const WARDEN_INVESTIGATOR_NAME_PATTERN = /^warden-([0-9a-f]{6})$/iu;

/** The largest sequence: `warden-FFFFFF`. The next one wraps to 1. */
export const WARDEN_INVESTIGATOR_MAX_SEQUENCE = SYSTEM_CALLSIGN_MAX_SEQUENCE;

/** The stored (lowercase) callsign for sequence `sequence`, 1 … {@link WARDEN_INVESTIGATOR_MAX_SEQUENCE}. */
export const wardenInvestigatorName = (sequence: number): string => systemCallsignName('warden', sequence);

/** The sequence number in an investigator's name, or `undefined` for any other name. */
export const wardenInvestigatorSequence = (name: string | undefined): number | undefined =>
  systemCallsignSequence('warden', name);

/** The next investigator sequence after `last` that is not in `inUse`. */
export const nextWardenInvestigatorSequence = nextSystemCallsignSequence;

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
  /**
   * Up to {@link WARDEN_HISTORY_DAYS} UTC days of work, oldest first, today last. Only days this daemon
   * kept a record for: a day it did not is missing, never a zero. Absent from an older daemon.
   */
  history: z.array(WardenDayStatsSchema).optional(),
  /** The actions of every day in `history` added up. Absent from an older daemon. */
  actionTotals: z.array(WardenActionTallySchema).optional(),
  /** The revive results of every day in `history` added up. Absent from an older daemon. */
  reviveTotals: WardenReviveResultsSchema.optional(),
  /** Jev's most recent checks, newest first, from the record kept beside the reports. Absent from an older daemon. */
  jevChecks: z.array(WardenJevCheckSchema).optional(),
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

/** Where the fleet's "who needs you" view is read (`agenda.wire.1`). */
export const WARDEN_AGENDA_PATH = '/v1/warden/agenda';

/** The older spelling, still served until the agenda removal release (docs/agenda.md § Compatibility). */
export const LEGACY_WARDEN_ATTENTION_PATH = '/v1/warden/attention';

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

export const FleetAgendaItemSchema = z.object({
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
export type FleetAgendaItem = z.infer<typeof FleetAgendaItemSchema>;

export const WardenAgendaOutcomeSchema = z.enum(['items', 'clean-sweep', 'degraded', 'no-sweep']);
export type WardenAgendaOutcome = z.infer<typeof WardenAgendaOutcomeSchema>;

/**
 * What the Warden needs the owner for: its own open Agenda cards (`raisedBy: daemon`, a `warden:`
 * source reference), read back from every live ferret's board — the same items the unified Agenda
 * inbox shows, never a second list. `warden-anomaly` and `warden-action` rows are no longer sent; the
 * enum keeps them so an app reads an older machine. The four outcomes never collapse: an unreadable
 * board is `degraded`, not an all-clear.
 */
export const WardenAgendaViewSchema = z.object({
  generatedAt: InstantSchema,
  lastSweepAt: InstantSchema.optional(),
  outcome: WardenAgendaOutcomeSchema,
  wardenDegraded: z.object({ since: InstantSchema.optional(), reason: z.string().min(1) }).optional(),
  items: z.array(FleetAgendaItemSchema),
  boardsWithParseErrors: z.array(z.object({ sessionId: z.string().min(1), parseErrors: PositiveIntegerSchema })),
  verdictCoverage: z.object({ limit: PositiveIntegerSchema, truncated: z.boolean() }),
});
export type WardenAgendaView = z.infer<typeof WardenAgendaViewSchema>;
