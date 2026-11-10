/**
 * Warden's wire schemas, copied from today's `protocol/src/lib/warden.ts` and `config-files.ts` (warden section) with the
 * words renamed (session -> ferret, task -> card, `FleetAgendaItem` -> `WardenAgendaItem`) and every compatibility path
 * dropped (`LegacyWardenTriage`, `migrateLegacyWardenSettings`, `migrateLegacyTriageStatus`, the `triage` key).
 *
 * The status statistics (`spend`, `savings`, `history`, `actionTotals`, `reviveTotals`, `jevChecks`) are today's
 * strict schemas, in the contract's words (a Jev check names its `ferret`); the daemon builds them and the app reads them.
 */
import { InstantSchema, NonNegativeFiniteSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema, FerretStateSchema } from '@ferretry/core-ferrets/contract';

const Positive = z.number().int().positive();
const NonNegative = z.number().int().nonnegative();

// ─── settings (`config/warden.yaml`) ─────────────────────────────────────────────────────────────────────────────
export const WARDEN_SWEEP_INTERVALS = [1, 2, 5, 10, 15] as const;
export const WardenSweepIntervalSchema = z.literal(WARDEN_SWEEP_INTERVALS);
export const WardenFailoverPolicySchema = z.enum(['fallback', 'round_robin']);
export const WardenAccountSchema = z.strictObject({ agent: z.string().min(1), model: z.string().optional() });
export const WardenFailoverConfigSchema = z.strictObject({
  policy: WardenFailoverPolicySchema,
  failureThreshold: Positive,
  cooldownMinutes: Positive,
});
export const ProviderOutageConfigSchema = z.strictObject({
  minDistinctFerrets: z.number().int().min(2),
  persistenceSweeps: z.number().int().min(2),
  tailLines: Positive,
});
export const WardenLayersSchema = z.strictObject({ jev: z.boolean(), llm: z.boolean() });
export const WARDEN_GUARD_THRESHOLD_RANGE = { min: 0.3, max: 0.95 } as const;
export const WardenGuardConfigSchema = z.strictObject({
  threshold: z.number().min(WARDEN_GUARD_THRESHOLD_RANGE.min).max(WARDEN_GUARD_THRESHOLD_RANGE.max),
  model: z.string().trim().min(1),
  endpoint: z.url({ protocol: /^https$/ }).optional(),
  usdPerMillionInputTokens: NonNegativeFiniteSchema,
});
const DailyCapSchema = z.number().finite().gt(0).max(100);
export const WardenCapsSchema = z.strictObject({
  jevUsdPerDay: DailyCapSchema,
  investigationUsdPerDay: DailyCapSchema,
  maxInvestigationsPerHour: z.number().int().min(1).max(60),
});
const JevActThreshold = z.number().min(0.3).max(1);
export const WardenJevActsSchema = z.strictObject({
  nudge: JevActThreshold,
  resume: JevActThreshold,
  restart: JevActThreshold,
  stop: JevActThreshold,
});
export const DEFAULT_WARDEN_JEV_ACTS = { nudge: 0.7, resume: 0.7, restart: 0.7, stop: 0.8 } as const;
export const WardenMayActAloneSchema = z.strictObject({
  nudge: z.boolean(),
  resume: z.boolean(),
  restart: z.boolean(),
  failover: z.boolean(),
  stop: z.boolean(),
  closeLeftovers: z.boolean(),
});
export const WardenEventTriggersSchema = z.strictObject({
  turnEnd: z.boolean(),
  question: z.boolean(),
  paneDied: z.boolean(),
});
export const WardenInvestigationConfigSchema = z.strictObject({ effort: z.enum(['low', 'medium', 'high']) });
export const WardenReviveConfigSchema = z.strictObject({
  enabled: z.boolean(),
  windowMinutes: Positive,
  cooldownMinutes: Positive,
  waveSize: z.number().int().min(1).max(3),
  waveGapSeconds: z.number().int().min(10),
  breakerMinutes: Positive,
});
export const DEFAULT_WARDEN_REVIVE = {
  enabled: true,
  windowMinutes: 15,
  cooldownMinutes: 30,
  waveSize: 3,
  waveGapSeconds: 10,
  breakerMinutes: 30,
} as const;
export const WARDEN_AUTO_MOVE_TRIGGERS = ['rate_limited', 'budget_exceeded'] as const;
export const WardenAutoMoveConfigSchema = z.strictObject({
  enabled: z.boolean(),
  when: z.array(z.enum(WARDEN_AUTO_MOVE_TRIGGERS)),
  targets: z.array(z.string().trim().min(1)),
  forceStopBackground: z.boolean(),
  waitMinutes: z.number().int().min(1).max(60),
  maxMovesPerHour: z.number().int().min(1).max(6),
  minHeadroomPercent: z.number().int().min(0).max(90),
});
export const DEFAULT_WARDEN_AUTO_MOVE = {
  enabled: false,
  when: ['rate_limited', 'budget_exceeded'],
  targets: [],
  forceStopBackground: false,
  waitMinutes: 10,
  maxMovesPerHour: 1,
  minHeadroomPercent: 20,
} as const;

const ConfigShape = {
  enabled: z.boolean(),
  revive: WardenReviveConfigSchema,
  autoMove: WardenAutoMoveConfigSchema,
  layers: WardenLayersSchema,
  guard: WardenGuardConfigSchema,
  caps: WardenCapsSchema,
  mayActAlone: WardenMayActAloneSchema,
  jevActs: WardenJevActsSchema,
  events: WardenEventTriggersSchema,
  investigation: WardenInvestigationConfigSchema,
  accounts: z.array(WardenAccountSchema),
  failover: WardenFailoverConfigSchema,
  providerOutage: ProviderOutageConfigSchema,
  intervalMinutes: WardenSweepIntervalSchema,
  unattendedMinutes: Positive,
  minSpawnGapMinutes: NonNegative,
  susThinkingSeconds: Positive,
  susSubprocessSeconds: Positive,
  maxAssignedWardens: Positive,
  assignedCooldownMinutes: NonNegative,
  blessMinutes: NonNegative,
};
/** The effective settings: every key present. */
export const WardenConfigSchema = z.strictObject(ConfigShape);
export type WardenConfig = z.infer<typeof WardenConfigSchema>;
/**
 * The ONE spelling `jev.key` takes: a reference to the secret the manifest declares, never a value (a raw key is refused
 * by the kernel's writer, and adding the reference is the owner's alone, so an agent's write that adds it is held).
 */
export const WARDEN_JEV_KEY_REFERENCE = '${secret:JEV_API_KEY}';
/**
 * `jev` in `warden.yaml`: which secret the Jev guard spends. Unset, the kernel answers `not_configured` and the guard
 * `not_set`, as before: nothing is sent and nothing is spent. It is the kernel's to read (`kernel.secrets`), not a
 * setting: it is not part of {@link WardenConfig}, and a settings save never writes it.
 */
export const WardenJevFileSchema = z.strictObject({ key: z.literal(WARDEN_JEV_KEY_REFERENCE).optional() });
/** `warden.yaml` as written: every setting optional, the nested sections too; what it leaves out is the default's. */
export const WardenFileSchema = z.strictObject({
  jev: WardenJevFileSchema.optional(),
  enabled: z.boolean().optional(),
  revive: WardenReviveConfigSchema.partial().optional(),
  autoMove: WardenAutoMoveConfigSchema.partial().optional(),
  layers: WardenLayersSchema.partial().optional(),
  guard: WardenGuardConfigSchema.partial().optional(),
  caps: WardenCapsSchema.partial().optional(),
  mayActAlone: WardenMayActAloneSchema.partial().optional(),
  jevActs: WardenJevActsSchema.partial().optional(),
  events: WardenEventTriggersSchema.partial().optional(),
  investigation: WardenInvestigationConfigSchema.partial().optional(),
  accounts: z.array(WardenAccountSchema).optional(),
  failover: WardenFailoverConfigSchema.partial().optional(),
  providerOutage: ProviderOutageConfigSchema.partial().optional(),
  intervalMinutes: WardenSweepIntervalSchema.optional(),
  unattendedMinutes: Positive.optional(),
  minSpawnGapMinutes: NonNegative.optional(),
  susThinkingSeconds: Positive.optional(),
  susSubprocessSeconds: Positive.optional(),
  maxAssignedWardens: Positive.optional(),
  assignedCooldownMinutes: NonNegative.optional(),
  blessMinutes: NonNegative.optional(),
});
export type WardenFile = z.infer<typeof WardenFileSchema>;
/**
 * What a settings save may name: `warden.yaml` without `jev`. The key reference is written into the file by its
 * owner, never through the settings route, so a save can neither add it nor take it away.
 */
export const WardenSettingsPatchSchema = WardenFileSchema.omit({ jev: true });
export type WardenSettingsPatch = z.infer<typeof WardenSettingsPatchSchema>;

/**
 * ON, AND FREE: the sweep runs every two minutes and its rules flag what they find, but both triage layers are off, so
 * nothing is spent until the owner switches Jev or LLM investigation on, each with its own daily cap. Stop is never
 * something an investigation may do alone by default.
 */
export const DEFAULT_WARDEN_CONFIG: WardenConfig = {
  enabled: true,
  revive: DEFAULT_WARDEN_REVIVE,
  autoMove: { ...DEFAULT_WARDEN_AUTO_MOVE, when: [...DEFAULT_WARDEN_AUTO_MOVE.when], targets: [] },
  layers: { jev: false, llm: false },
  guard: { threshold: 0.7, model: 'jev-latest', usdPerMillionInputTokens: 0.042 },
  caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 2, maxInvestigationsPerHour: 6 },
  mayActAlone: { nudge: true, resume: true, restart: true, failover: true, stop: false, closeLeftovers: true },
  jevActs: DEFAULT_WARDEN_JEV_ACTS,
  events: { turnEnd: true, question: true, paneDied: true },
  investigation: { effort: 'low' },
  accounts: [],
  failover: { policy: 'fallback', failureThreshold: 2, cooldownMinutes: 30 },
  providerOutage: { minDistinctFerrets: 2, persistenceSweeps: 2, tailLines: 24 },
  intervalMinutes: 2,
  unattendedMinutes: 30,
  minSpawnGapMinutes: 15,
  susThinkingSeconds: 900,
  susSubprocessSeconds: 600,
  maxAssignedWardens: 1,
  assignedCooldownMinutes: 30,
  blessMinutes: 15,
};

/** The effective settings of a file: the default with the file's keys laid over it, one level into each section. */
export function effectiveWardenConfig(file: WardenFile): WardenConfig {
  // `jev` names the key the kernel spends; it is no setting, so it never reaches the settings.
  const { jev: _key, ...settings } = file;
  const merged: Record<string, unknown> = { ...DEFAULT_WARDEN_CONFIG, ...settings };
  for (const section of [
    'revive',
    'autoMove',
    'layers',
    'guard',
    'caps',
    'mayActAlone',
    'jevActs',
    'events',
    'investigation',
    'failover',
    'providerOutage',
  ] as const)
    merged[section] = { ...DEFAULT_WARDEN_CONFIG[section], ...(file[section] ?? {}) };
  return WardenConfigSchema.parse(merged);
}

/**
 * Which edits of `warden.yaml` LOOSEN what the warden may do or spend (§7.2): a loosening edit is held for the owner.
 * Each entry is a plain sentence naming what widened. Switching things off, lowering a cap or raising a bar never loosens.
 */
export function wardenLoosens(before: WardenFile | undefined, after: WardenFile): readonly string[] {
  const was = effectiveWardenConfig(before ?? {});
  const now = effectiveWardenConfig(after);
  const out: string[] = [];
  if (!was.enabled && now.enabled) out.push('the warden is switched on');
  for (const act of Object.keys(now.mayActAlone) as (keyof WardenConfig['mayActAlone'])[])
    if (!was.mayActAlone[act] && now.mayActAlone[act]) out.push(`the warden may ${act} alone`);
  for (const layer of ['jev', 'llm'] as const)
    if (!was.layers[layer] && now.layers[layer]) out.push(`${layer} triage is switched on`);
  for (const cap of ['jevUsdPerDay', 'investigationUsdPerDay', 'maxInvestigationsPerHour'] as const)
    if (now.caps[cap] > was.caps[cap]) out.push(`the ${cap} cap is raised`);
  for (const act of Object.keys(now.jevActs) as (keyof WardenConfig['jevActs'])[])
    if (now.jevActs[act] < was.jevActs[act]) out.push(`the confidence needed to ${act} is lowered`);
  if (now.guard.threshold < was.guard.threshold) out.push('the guard threshold is lowered');
  if (!was.autoMove.enabled && now.autoMove.enabled) out.push('the warden may move ferrets between logins');
  if (now.autoMove.maxMovesPerHour > was.autoMove.maxMovesPerHour) out.push('more moves per hour are allowed');
  if (now.maxAssignedWardens > was.maxAssignedWardens) out.push('more wardens may run at once');
  out.push(...spendPaceLoosens(was, now), ...autoMoveLoosens(was, now));
  if (
    now.accounts.some(
      account => !was.accounts.some(known => known.agent === account.agent && known.model === account.model),
    )
  )
    out.push('a login is added to the warden’s failover list');
  return out;
}

const goesDown = (before: number, after: number, what: string): readonly string[] =>
  after < before ? [`${what} goes down from ${String(before)} to ${String(after)}`] : [];

/**
 * A lower Jev price makes the dollar cap count less than is really spent; a shorter sweep or spawn gap makes the
 * warden spend more often. Each is held for the owner, in the words the owner confirmed them in before 5.0.
 */
function spendPaceLoosens(was: WardenConfig, now: WardenConfig): readonly string[] {
  return [
    ...goesDown(
      was.guard.usdPerMillionInputTokens,
      now.guard.usdPerMillionInputTokens,
      'the Jev price the cap counts with',
    ),
    ...goesDown(was.intervalMinutes, now.intervalMinutes, 'the minutes between Warden sweeps'),
    ...goesDown(was.minSpawnGapMinutes, now.minSpawnGapMinutes, 'the minutes between two Warden investigations'),
  ];
}

/** Moving a ferret acts only while the warden is on AND moving is. */
const movesOn = (config: WardenConfig): boolean => config.enabled && config.autoMove.enabled;

const AUTO_MOVE_TRIGGER_WORDS: Readonly<Record<(typeof WARDEN_AUTO_MOVE_TRIGGERS)[number], string>> = {
  rate_limited: 'whose login hit a usage limit',
  budget_exceeded: 'whose login passed its hard spend budget',
};

/**
 * A move destroys a ferret's pane and starts it again elsewhere, so whatever lets the warden move in more cases is
 * held: letting it stop background jobs, a new trigger, a newly named login (it may be another provider's, which
 * "any ready login" never reaches), going from a list to any ready login, and a lower headroom floor.
 */
function autoMoveLoosens(was: WardenConfig, now: WardenConfig): readonly string[] {
  const before = was.autoMove;
  const after = now.autoMove;
  return [
    ...(!(movesOn(was) && before.forceStopBackground) && movesOn(now) && after.forceStopBackground
      ? ["the Warden may now stop a ferret's own background jobs to move it"]
      : []),
    ...after.when
      .filter(trigger => !before.when.includes(trigger))
      .map(trigger => `the Warden now also moves a ferret ${AUTO_MOVE_TRIGGER_WORDS[trigger]}`),
    ...after.targets
      .filter(target => !before.targets.includes(target))
      .map(target => `the Warden may now move ferrets onto ${target}`),
    ...(before.targets.length > 0 && after.targets.length === 0
      ? ['the Warden may now move ferrets onto any ready login of the same harness and provider']
      : []),
    ...goesDown(
      before.minHeadroomPercent,
      after.minHeadroomPercent,
      'the share a login must have left to be moved onto',
    ),
  ];
}

// ─── detection ───────────────────────────────────────────────────────────────────────────────────────────────────
export const WardenAnomalyKindSchema = z.enum([
  'dead_monitor',
  'unattended_question',
  'abandoned_wreckage',
  'quota_reset_passed',
  'declared_wait_overdue',
  'peer_wait_unanswerable',
  'sus_thinking',
  'sus_subprocess',
  'agent_frozen',
  'bootstrap_degraded',
  'provider_unavailable',
  'owner_request',
  'orphaned_card',
  'report_overdue',
  'input_stuck',
  'inbox_stuck',
]);
export type WardenAnomalyKind = z.infer<typeof WardenAnomalyKindSchema>;
export const LivenessLedgerSchema = z.strictObject({
  lastTranscriptAt: InstantSchema.optional(),
  lastCounterAdvanceAt: InstantSchema.optional(),
  lastTokenAdvanceAt: InstantSchema.optional(),
  lastSubprocessAt: InstantSchema.optional(),
  lastPaneChangeAt: InstantSchema.optional(),
  lastMeaningfulPaneAt: InstantSchema.optional(),
  subprocessSince: InstantSchema.optional(),
  subprocessKey: z.string().min(1).optional(),
});
/** A flag: the warden noticing trouble on one ferret. */
export const WardenFlagSchema = z.strictObject({
  kind: WardenAnomalyKindSchema,
  ferret: FerretIdSchema,
  generation: NonNegative.optional(),
  provider: z.string().optional(),
  affectedFerrets: z.array(z.string()).optional(),
  failureClasses: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  state: FerretStateSchema,
  detail: z.string().min(1),
  since: InstantSchema.optional(),
  idleMinutes: NonNegativeFiniteSchema.optional(),
  assignedWarden: z.boolean().optional(),
  ledger: LivenessLedgerSchema.optional(),
  subject: z.string().min(1).optional(),
  card: z.strictObject({ id: z.string().min(1) }).optional(),
});
export type WardenFlag = z.infer<typeof WardenFlagSchema>;

// ─── judging ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const WardenVerdictKindSchema = z.enum(['killed', 'revived', 'nudged', 'cleared', 'needs_human', 'unknown']);
export const WardenRecommendedActionSchema = z.enum(['nudge', 'stop', 'resume', 'restart', 'move', 'leave']);
export const WardenRecommendationSchema = z.strictObject({
  action: WardenRecommendedActionSchema,
  reason: z.string(),
  agent: z.string().min(1).optional(),
});
export const WardenVerdictSchema = z.strictObject({
  at: InstantSchema,
  target: FerretIdSchema.optional(),
  name: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  anomalyKind: WardenAnomalyKindSchema.optional(),
  verdict: WardenVerdictKindSchema,
  explicitNeedsHuman: z.boolean().optional(),
  recommendation: WardenRecommendationSchema.optional(),
  reason: z.string().min(1).optional(),
  reportPath: z.string().min(1),
  spawn: z.looseObject({ agent: z.string().min(1), model: z.string().min(1) }).optional(),
});
export const WardenVerdictsViewSchema = z.array(WardenVerdictSchema);

// ─── remedies ────────────────────────────────────────────────────────────────────────────────────────────────────
export const WardenClearedBySchema = z.enum(['jev', 'warden', 'owner']);
export const WardenActionKindSchema = z.enum([
  'bless',
  'nudge',
  'resume',
  'restart',
  'stop',
  'failover',
  'close_leftover',
  'revive',
]);
export const WardenActionOutcomeSchema = z.enum(['done', 'held', 'failed']);
export const WardenActionSchema = z.looseObject({
  at: InstantSchema,
  ferret: FerretIdSchema,
  action: WardenActionKindSchema,
  outcome: WardenActionOutcomeSchema,
  by: WardenClearedBySchema,
  anomalyKind: WardenAnomalyKindSchema.optional(),
  detail: z.string().min(1),
});
export const WardenInvestigationSchema = z.strictObject({
  id: z.string().min(1),
  state: z.enum(['queued', 'running', 'done']),
  scope: z.enum(['ferret', 'pack']),
  origin: z.enum(['sweep', 'jev', 'owner']),
  target: FerretIdSchema.optional(),
  anomalyKind: WardenAnomalyKindSchema.optional(),
  warden: FerretIdSchema.optional(),
  queuedAt: InstantSchema.optional(),
  startedAt: InstantSchema.optional(),
  finishedAt: InstantSchema.optional(),
  reportPath: z.string().min(1).optional(),
  verdict: WardenVerdictKindSchema.optional(),
  costUsd: NonNegativeFiniteSchema.optional(),
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  wardenName: z.string().min(1).optional(),
});
export const WardenBlessingViewSchema = z.strictObject({
  ferret: FerretIdSchema,
  kinds: z.array(WardenAnomalyKindSchema),
  expiresAt: InstantSchema,
  by: WardenClearedBySchema,
  streak: Positive.optional(),
  untilChange: z.literal(true).optional(),
});
export type WardenBlessingView = z.infer<typeof WardenBlessingViewSchema>;

// ─── the routes ──────────────────────────────────────────────────────────────────────────────────────────────────
export const WardenTriageReasonSchema = z.enum(['configured', 'disabled', 'jev_cap', 'investigation_cap', 'no_login']);
export const WardenLayerStatusSchema = z.strictObject({
  configured: z.boolean(),
  active: z.boolean(),
  reason: WardenTriageReasonSchema,
});
export const WardenTriageStatusSchema = z.looseObject({ jev: WardenLayerStatusSchema, llm: WardenLayerStatusSchema });

// ─── the status statistics (today's `protocol/src/lib/warden.ts`) ──────────────────────────────────────────────────
export const WardenSpendDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const WardenCapSchema = z.enum(['jev', 'investigation']);
export const WardenSpendSchema = z.object({
  day: WardenSpendDaySchema,
  jevUsd: NonNegativeFiniteSchema,
  jevCapUsd: NonNegativeFiniteSchema,
  investigationUsd: NonNegativeFiniteSchema,
  investigationCapUsd: NonNegativeFiniteSchema,
  pendingInvestigations: NonNegative,
  capsHit: z.array(WardenCapSchema),
  capsPaced: z.array(WardenCapSchema).optional(),
  pacedUntil: InstantSchema.optional(),
  investigationsLastHour: NonNegative,
  maxInvestigationsPerHour: Positive,
});
export const WardenSavingsSchema = z.object({
  day: WardenSpendDaySchema,
  flags: NonNegative,
  jevDecisions: NonNegative,
  jevSkips: NonNegative,
  jevActions: NonNegative.optional(),
  investigations: NonNegative,
  averageInvestigationUsd: NonNegativeFiniteSchema.optional(),
  savedUsd: NonNegativeFiniteSchema.optional(),
});
export const WardenActorCountsSchema = z.object({
  auto: NonNegative,
  jev: NonNegative,
  llm: NonNegative,
  owner: NonNegative.optional(),
});
/** An action kind as the statistics count it: `escalate` is a notification to the owner. */
export const WardenStatActionSchema = z.enum([...WardenActionKindSchema.options, 'escalate']);
export const WardenActionTallySchema = WardenActorCountsSchema.extend({
  action: WardenStatActionSchema,
  outcome: WardenActionOutcomeSchema,
});
export const WardenReviveResultsSchema = z.object({
  progressed: WardenActorCountsSchema,
  stalled: WardenActorCountsSchema,
});
export const WardenJevCheckVerdictSchema = z.enum(['healthy', 'acted', 'handed_on', 'skipped']);
export const WardenJevCheckWhySchema = z.enum([
  'unsure',
  'not_sure_enough',
  'never_alone',
  'not_allowed',
  'no_message',
  'cannot_choose_login',
  'not_offered',
  'failed',
  'already_acted',
  'act_failed',
  'jev_cap',
  'jev_paced',
]);
export const WardenJevCheckRouteSchema = z.enum(['investigation', 'owner']);
export const WARDEN_JEV_PATH_MAX = 12;
export const WardenJevPathStepSchema = z.object({
  node: z.string().min(1).max(64),
  kind: z.enum(['fact', 'judgement']),
  answer: z.enum(['yes', 'no']),
  confidence: z.number().min(0).max(1).optional(),
});
export const WardenJevPathSchema = z.array(WardenJevPathStepSchema).max(WARDEN_JEV_PATH_MAX);
/** One check Jev made of a flag, naming the ferret it was about. */
export const WardenJevCheckSchema = z.object({
  at: InstantSchema,
  ferret: z.string().min(1),
  anomalyKind: WardenAnomalyKindSchema,
  verdict: WardenJevCheckVerdictSchema,
  act: WardenActionKindSchema.exclude(['bless', 'close_leftover', 'revive']).optional(),
  why: WardenJevCheckWhySchema.optional(),
  route: WardenJevCheckRouteSchema.optional(),
  confidence: z.number().min(0).max(1),
  costUsd: NonNegativeFiniteSchema,
  path: WardenJevPathSchema.optional(),
  node: z.string().min(1).max(64).optional(),
});
export const WardenJevDayStatsSchema = z.object({
  checks: NonNegative,
  healthy: NonNegative,
  acted: NonNegative,
  handedOn: NonNegative,
  skippedForCap: NonNegative,
});
export const WardenDayStatsSchema = z.object({
  day: WardenSpendDaySchema,
  flags: NonNegative,
  jevDecisions: NonNegative,
  investigations: NonNegative,
  jevUsd: NonNegativeFiniteSchema,
  investigationUsd: NonNegativeFiniteSchema,
  moved: WardenActorCountsSchema,
  cleared: WardenActorCountsSchema,
  stopped: WardenActorCountsSchema,
  asked: WardenActorCountsSchema,
  jev: WardenJevDayStatsSchema.optional(),
  acts: z.array(WardenActionTallySchema).optional(),
  reviveResults: WardenReviveResultsSchema.optional(),
});

/** `GET /v1/warden/status`. */
export const WardenStatusViewSchema = z.looseObject({
  config: WardenConfigSchema,
  lastSweepAt: InstantSchema.optional(),
  nextSweepAt: InstantSchema.optional(),
  flags: z.array(WardenFlagSchema),
  fingerprint: z.string(),
  liveWarden: z.string().optional(),
  lastSpawnAt: InstantSchema.optional(),
  lastReport: z.strictObject({ reportId: z.string().min(1), head: z.string() }).optional(),
  triage: WardenTriageStatusSchema,
  spend: WardenSpendSchema,
  savings: WardenSavingsSchema,
  investigations: z.array(WardenInvestigationSchema),
  actions: z.array(WardenActionSchema),
  blessings: z.array(WardenBlessingViewSchema),
  history: z.array(WardenDayStatsSchema).optional(),
  actionTotals: z.array(WardenActionTallySchema).optional(),
  reviveTotals: WardenReviveResultsSchema.optional(),
  jevChecks: z.array(WardenJevCheckSchema).optional(),
});
/** `POST /v1/warden/run`: `spawn` also starts a warden for what the sweep found; default off. */
export const WardenRunRequestSchema = z.strictObject({ spawn: z.boolean().default(false) });
export const WardenRunViewSchema = z.strictObject({
  sweptAt: InstantSchema,
  flags: z.array(WardenFlagSchema),
  spawned: z.string().optional(),
  assignedWardens: z.array(z.string()).optional(),
  message: z.string().optional(),
});
export const WardenInvestigateRequestSchema = z.strictObject({
  ferret: FerretIdSchema,
  note: z.string().trim().min(1).max(500).optional(),
});
export const WardenInvestigateViewSchema = z.strictObject({
  ferret: FerretIdSchema,
  state: z.enum(['queued', 'running']),
  position: Positive.optional(),
  warden: FerretIdSchema.optional(),
  message: z.string().min(1),
});
export const WARDEN_LEAVE_DURATIONS = ['1h', '4h', 'until_change'] as const;
export const WardenLeaveDurationSchema = z.enum(WARDEN_LEAVE_DURATIONS);
export const WardenLeaveRequestSchema = z.strictObject({ ferret: FerretIdSchema, duration: WardenLeaveDurationSchema });
export const WardenLeaveViewSchema = z.strictObject({ blessing: WardenBlessingViewSchema, message: z.string().min(1) });

/** `GET /v1/warden/agenda`: who needs you, with the warden's judgement of each. Read-only. */
export const WardenJudgementSchema = z.strictObject({
  state: z.enum(['judged', 'pending', 'queued', 'failed', 'none']),
  verdict: WardenVerdictKindSchema.optional(),
  reason: z.string().min(1),
  judgedBy: z.looseObject({}).optional(),
  at: InstantSchema.optional(),
  reportPath: z.string().min(1).optional(),
  recommendation: WardenRecommendationSchema.optional(),
  stale: z.boolean().optional(),
});
export const WardenAgendaItemSchema = z.strictObject({
  ferret: FerretIdSchema,
  name: z.string().optional(),
  label: z.string().optional(),
  ferretState: FerretStateSchema.optional(),
  id: z.string().min(1),
  source: z.enum(['card', 'question', 'agent-raised', 'warden-flag', 'warden-action']),
  subject: z.string(),
  why: z.string(),
  context: z.string().optional(),
  waitingSince: InstantSchema,
  howToResolve: z.string(),
  recommendation: WardenRecommendationSchema.optional(),
  raisedBy: z.enum(['human', 'agent', 'daemon']).optional(),
  raisedByName: z.string().optional(),
  judgement: WardenJudgementSchema.optional(),
  fromFlag: z.boolean().optional(),
  provider: z.string().optional(),
  anomalyKind: WardenAnomalyKindSchema.optional(),
});
export const WardenAgendaViewSchema = z.strictObject({
  generatedAt: InstantSchema,
  lastSweepAt: InstantSchema.optional(),
  outcome: z.enum(['items', 'clean-sweep', 'degraded', 'no-sweep']),
  wardenDegraded: z.strictObject({ since: InstantSchema.optional(), reason: z.string().min(1) }).optional(),
  items: z.array(WardenAgendaItemSchema),
  verdictCoverage: z.strictObject({ limit: Positive, truncated: z.boolean() }),
});

// ─── stored files ────────────────────────────────────────────────────────────────────────────────────────────────
/** `state/warden/state.json`: sweep memory (fingerprint, last spawn, liveness ledgers). Condensed. */
export const WardenStateFileSchema = z.looseObject({ format: z.literal(1) });
/** `state/warden/remembered.json`: the blessings ("leave it alone"). Damaged reads as none: the warden judges again. */
export const RememberedFileSchema = z.strictObject({
  format: z.literal(1),
  blessings: z.array(WardenBlessingViewSchema),
});
/** `state/warden/jev-checks/<day>.json`: one day of guard-model checks. Condensed. */
export const JevChecksFileSchema = z.looseObject({ format: z.literal(1) });

export type WardenInvestigateRequest = z.infer<typeof WardenInvestigateRequestSchema>;
export type WardenLeaveRequest = z.infer<typeof WardenLeaveRequestSchema>;
export type WardenRunView = z.infer<typeof WardenRunViewSchema>;

/** `GET /v1/warden/config` and the answer to `PATCH`: the effective settings and what an owner should know about them. */
export const WardenLoginViewSchema = z.strictObject({
  source: z.enum(['configured', 'machine_default', 'not_set']),
  unknown: z.array(z.string().min(1)),
  available: z.array(z.string().min(1)),
});
export const WardenConfigViewSchema = z.strictObject({
  config: WardenConfigSchema,
  accounts: z.array(WardenAccountSchema),
  warnings: z.array(z.string()),
  login: WardenLoginViewSchema.optional(),
  /** On a settings change only: the sentences of the edit the daemon held for the owner (a loosening waits for them). */
  held: z.array(z.string()).optional(),
});
export type WardenConfigView = z.infer<typeof WardenConfigViewSchema>;
