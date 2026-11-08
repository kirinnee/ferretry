/**
 * The shapes warden's logic computes with: today's `protocol/src/lib/warden.ts`, copied with the compatibility paths
 * dropped (`LegacyWardenTriage`, the settings, status and spend pre-processors) and the old verb for a move renamed. The settings and the kinds are the contract's (`../../contract`); what is here are the internal views
 * the sweep builds, which `wire-map.ts` restates in the contract's words (ferret, flag, card) at the route.
 */
import { NonNegativeFiniteSchema } from '@ferretry/std';
import { z } from 'zod';
import {
  DEFAULT_WARDEN_REVIVE,
  WARDEN_AUTO_MOVE_TRIGGERS,
  WardenAccountSchema,
  WardenAnomalyKindSchema,
  WardenCapsSchema,
  WardenClearedBySchema,
  WardenConfigSchema,
  WardenSettingsPatchSchema,
  WardenEventTriggersSchema,
  WardenFailoverPolicySchema,
  WardenGuardConfigSchema,
  WardenJevActsSchema,
  WardenLayerStatusSchema,
  WardenLayersSchema,
  WardenLeaveDurationSchema,
  WardenMayActAloneSchema,
  WardenRecommendationSchema,
  WardenReviveConfigSchema,
  WardenTriageReasonSchema,
  WardenVerdictKindSchema,
  type WardenConfig,
  type WardenSettingsPatch,
} from '../../contract/index.ts';
import { CardRefSchema } from '@ferretry/plugin-board/contract';
import {
  nextSystemCallsignSequence,
  SYSTEM_CALLSIGN_MAX_SEQUENCE,
  type SessionStatus,
  SessionStatusSchema,
  systemCallsignName,
  systemCallsignSequence,
} from './foreign.ts';

/** An instant as the sweep's own computing shapes carry it: an ISO date-time with an offset (not the branded wire type). */
const InstantSchema = z.iso.datetime({ offset: true });

const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();

export {
  DEFAULT_WARDEN_REVIVE,
  WardenClearedBySchema,
  WardenConfigSchema,
  WardenSettingsPatchSchema,
  WardenVerdictKindSchema,
};
export { WardenJevActsSchema };
export type { SessionStatus, WardenConfig };
export const WardenAutoMoveTriggerSchema = z.enum(WARDEN_AUTO_MOVE_TRIGGERS);
/** The settings that are mappings of sub-settings: the one list that decides merge-by-sub-key vs whole (Warden's adapters import it). */
export const WARDEN_CONFIG_SECTIONS = [
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
] as const satisfies readonly (keyof WardenConfig)[];
/** The settings with a patch laid over them, one level into each section (today's `mergeWardenConfig`). */
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
export const DEFAULT_WARDEN_CONFIG = effectiveDefault();
function effectiveDefault(): WardenConfig {
  return effectiveWardenConfigOf({});
}
import { effectiveWardenConfig as effectiveWardenConfigOf } from '../../contract/index.ts';

/** The most a blessing may last, whatever the owner or the growth rule asks. */
export const WARDEN_BLESSING_CEILING_MINUTES = 240;

export type WardenLayers = z.infer<typeof WardenLayersSchema>;
export type WardenGuardConfig = z.infer<typeof WardenGuardConfigSchema>;
export type WardenCaps = z.infer<typeof WardenCapsSchema>;
export type WardenJevActs = z.infer<typeof WardenJevActsSchema>;
export type WardenJevAct = keyof WardenJevActs;
export type WardenMayActAlone = z.infer<typeof WardenMayActAloneSchema>;
export type WardenEventTriggers = z.infer<typeof WardenEventTriggersSchema>;
export type WardenEventTrigger = keyof WardenEventTriggers;
export type WardenReviveConfig = z.infer<typeof WardenReviveConfigSchema>;
export type WardenAutoMoveTrigger = (typeof WARDEN_AUTO_MOVE_TRIGGERS)[number];
export type WardenConfigPatch = WardenSettingsPatch;
const LivenessLedgerSchema = z.object({
  lastTranscriptAt: InstantSchema.optional(),
  lastCounterAdvanceAt: InstantSchema.optional(),
  lastTokenAdvanceAt: InstantSchema.optional(),
  lastSubprocessAt: InstantSchema.optional(),
  lastPaneChangeAt: InstantSchema.optional(),
  lastMeaningfulPaneAt: InstantSchema.optional(),
  subprocessSince: InstantSchema.optional(),
  subprocessKey: z.string().min(1).optional(),
});

const WardenAnomalySchema = z.object({
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
  subject: z.string().min(1).optional(),
  task: CardRefSchema.optional(),
});
export type WardenAnomaly = z.infer<typeof WardenAnomalySchema>;
const WardenStuckInputFlagSchema = WardenAnomalySchema.extend({ kind: z.literal('input_stuck') });
export type WardenStuckInputFlag = z.infer<typeof WardenStuckInputFlagSchema>;
const WardenStuckInboxFlagSchema = WardenAnomalySchema.extend({ kind: z.literal('inbox_stuck') });
export type WardenStuckInboxFlag = z.infer<typeof WardenStuckInboxFlagSchema>;
export function wardenFlags(view: {
  readonly anomalies: readonly WardenAnomaly[];
  readonly stuckInput?: readonly WardenStuckInputFlag[] | undefined;
  readonly stuckInbox?: readonly WardenStuckInboxFlag[] | undefined;
}): readonly WardenAnomaly[] {
  return [...view.anomalies, ...(view.stuckInput ?? []), ...(view.stuckInbox ?? [])];
}
const WardenFailoverAccountViewSchema = z.object({
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
const WardenFailoverStatusSchema = z.object({
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
const WardenLoginSourceSchema = z.enum(['configured', 'machine_default', 'not_set']);
const WardenLoginSchema = z.object({
  source: WardenLoginSourceSchema,
  unknown: z.array(z.string().min(1)),
  available: z.array(z.string().min(1)),
});
export type WardenLogin = z.infer<typeof WardenLoginSchema>;
const WardenConfigViewSchema = z.object({
  config: WardenConfigSchema,
  accounts: z.array(WardenAccountSchema),
  warnings: z.array(z.string()),
  login: WardenLoginSchema.optional(),
  held: z.array(z.string()).optional(),
});
export type WardenConfigView = z.infer<typeof WardenConfigViewSchema>;
const WardenVerdictSpawnSchema = z.object({
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
const WardenVerdictSchema = z.object({
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
  'unredacted',
]);
export type WardenGuardFailureCode = z.infer<typeof WardenGuardFailureCodeSchema>;
export type WardenLayerStatus = z.infer<typeof WardenLayerStatusSchema>;
const WardenTriageStatusSchema = z.object({
  jev: WardenLayerStatusSchema,
  llm: WardenLayerStatusSchema,
  guardFailure: z.object({ code: WardenGuardFailureCodeSchema, at: InstantSchema }).optional(),
  guardBackoffUntil: InstantSchema.optional(),
});
export type WardenTriageStatus = z.infer<typeof WardenTriageStatusSchema>;
const WardenSpendDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const WardenCapSchema = z.enum(['jev', 'investigation']);
export type WardenCap = z.infer<typeof WardenCapSchema>;
const WardenSpendSchema = z.object({
  day: WardenSpendDaySchema,
  jevUsd: NonNegativeFiniteSchema,
  jevCapUsd: NonNegativeFiniteSchema,
  investigationUsd: NonNegativeFiniteSchema,
  investigationCapUsd: NonNegativeFiniteSchema,
  pendingInvestigations: NonNegativeIntegerSchema,
  capsHit: z.array(WardenCapSchema),
  capsPaced: z.array(WardenCapSchema).optional(),
  pacedUntil: InstantSchema.optional(),
  investigationsLastHour: NonNegativeIntegerSchema,
  maxInvestigationsPerHour: PositiveIntegerSchema,
});
export type WardenSpend = z.infer<typeof WardenSpendSchema>;
const WardenSavingsSchema = z.object({
  day: WardenSpendDaySchema,
  flags: NonNegativeIntegerSchema,
  jevDecisions: NonNegativeIntegerSchema,
  jevSkips: NonNegativeIntegerSchema,
  jevActions: NonNegativeIntegerSchema.optional(),
  investigations: NonNegativeIntegerSchema,
  averageInvestigationUsd: NonNegativeFiniteSchema.optional(),
  savedUsd: NonNegativeFiniteSchema.optional(),
});
export type WardenSavings = z.infer<typeof WardenSavingsSchema>;
const WardenInvestigationStateSchema = z.enum(['queued', 'running', 'done']);
export const WardenInvestigationOriginSchema = z.enum(['sweep', 'jev', 'owner']);
export type WardenInvestigationOrigin = z.infer<typeof WardenInvestigationOriginSchema>;
const WardenInvestigationSchema = z.object({
  id: z.string().min(1),
  state: WardenInvestigationStateSchema,
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
  costUsd: NonNegativeFiniteSchema.optional(),
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  wardenName: z.string().min(1).optional(),
  jev: z.lazy(() => WardenJevBeforeSchema).optional(),
});
export type WardenInvestigation = z.infer<typeof WardenInvestigationSchema>;
export type WardenClearedBy = z.infer<typeof WardenClearedBySchema>;
const WardenActionKindSchema = z.enum([
  'bless',
  'nudge',
  'resume',
  'restart',
  'stop',
  'failover',
  'close_leftover',
  'revive',
]);
export type WardenActionKind = z.infer<typeof WardenActionKindSchema>;
const WardenActionOutcomeSchema = z.enum(['done', 'held', 'failed']);
export type WardenActionOutcome = z.infer<typeof WardenActionOutcomeSchema>;
export const WardenActorSchema = z.enum(['auto', 'jev', 'llm', 'owner']);
export type WardenActor = z.infer<typeof WardenActorSchema>;
const WardenOutcomeSchema = z.enum(['moved', 'cleared', 'stopped', 'asked']);
export type WardenOutcome = z.infer<typeof WardenOutcomeSchema>;
export const WardenActionSchema = z.object({
  at: InstantSchema,
  sessionId: z.string().min(1),
  action: WardenActionKindSchema,
  outcome: WardenActionOutcomeSchema,
  by: WardenClearedBySchema,
  anomalyKind: WardenAnomalyKindSchema.optional(),
  detail: z.string().min(1),
  reportPath: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().min(1).max(500).optional(),
  agent: z.string().min(1).optional(),
  fromAgent: z.string().min(1).optional(),
  actor: WardenActorSchema.optional(),
  investigator: z.string().min(1).optional(),
  jev: z.lazy(() => WardenJevBeforeSchema).optional(),
});
export type WardenAction = z.infer<typeof WardenActionSchema>;
export function wardenActionActor(action: Pick<WardenAction, 'actor' | 'by' | 'reportPath'>): WardenActor {
  if (action.actor !== undefined) return action.actor;
  if (action.by === 'jev') return 'jev';
  if (action.by === 'owner') return 'owner';
  return action.reportPath === undefined ? 'auto' : 'llm';
}
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
const WardenActorCountsSchema = z.object({
  auto: NonNegativeIntegerSchema,
  jev: NonNegativeIntegerSchema,
  llm: NonNegativeIntegerSchema,
  owner: NonNegativeIntegerSchema.optional(),
});
export type WardenActorCounts = z.infer<typeof WardenActorCountsSchema>;
const WardenStatActionSchema = z.enum([...WardenActionKindSchema.options, 'escalate']);
export type WardenStatActionKind = z.infer<typeof WardenStatActionSchema>;
const WardenActionTallySchema = WardenActorCountsSchema.extend({
  action: WardenStatActionSchema,
  outcome: WardenActionOutcomeSchema,
});
export type WardenActionTally = z.infer<typeof WardenActionTallySchema>;
const WardenReviveResultsSchema = z.object({
  progressed: WardenActorCountsSchema,
  stalled: WardenActorCountsSchema,
});
export type WardenReviveResults = z.infer<typeof WardenReviveResultsSchema>;
export const WARDEN_REVIVE_PROGRESS_MINUTES = 10;
const WardenJevCheckVerdictSchema = z.enum(['healthy', 'acted', 'handed_on', 'skipped']);
const WardenJevCheckWhySchema = z.enum([
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
const WardenJevCheckRouteSchema = z.enum(['investigation', 'owner']);
export type WardenJevCheckRoute = z.infer<typeof WardenJevCheckRouteSchema>;
const WARDEN_JEV_PATH_MAX = 12;
const WardenJevPathStepSchema = z.object({
  node: z.string().min(1).max(64),
  kind: z.enum(['fact', 'judgement']),
  answer: z.enum(['yes', 'no']),
  confidence: z.number().min(0).max(1).optional(),
});
export type WardenJevPathStep = z.infer<typeof WardenJevPathStepSchema>;
export const WardenJevPathSchema = z.array(WardenJevPathStepSchema).max(WARDEN_JEV_PATH_MAX);
export const WardenJevCheckSchema = z.object({
  at: InstantSchema,
  sessionId: z.string().min(1),
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
export type WardenJevCheck = z.infer<typeof WardenJevCheckSchema>;
const WardenJevDayStatsSchema = z.object({
  checks: NonNegativeIntegerSchema,
  healthy: NonNegativeIntegerSchema,
  acted: NonNegativeIntegerSchema,
  handedOn: NonNegativeIntegerSchema,
  skippedForCap: NonNegativeIntegerSchema,
});
export type WardenJevDayStats = z.infer<typeof WardenJevDayStatsSchema>;
const WardenJevBeforeWhySchema = z.enum([
  ...WardenJevCheckWhySchema.options,
  'owner_request',
  'forced',
  'not_judgeable',
  'backoff',
  'unredacted',
  'no_record',
]);
export const WardenJevBeforeSchema = z.object({
  verdict: z.enum(['handed_on', 'skipped', 'not_asked', 'off']),
  why: WardenJevBeforeWhySchema.optional(),
  act: WardenJevCheckSchema.shape.act,
  at: InstantSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  costUsd: NonNegativeFiniteSchema.optional(),
  path: WardenJevPathSchema.optional(),
  node: z.string().min(1).max(64).optional(),
});
export type WardenJevBefore = z.infer<typeof WardenJevBeforeSchema>;
export const WardenDayStatsSchema = z.object({
  day: WardenSpendDaySchema,
  flags: NonNegativeIntegerSchema,
  jevDecisions: NonNegativeIntegerSchema,
  investigations: NonNegativeIntegerSchema,
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
export type WardenDayStats = z.infer<typeof WardenDayStatsSchema>;
export const WARDEN_HISTORY_DAYS = 30;
export const WARDEN_INVESTIGATOR_MAX_SEQUENCE = SYSTEM_CALLSIGN_MAX_SEQUENCE;
export const wardenInvestigatorName = (sequence: number): string => systemCallsignName('warden', sequence);
export const wardenInvestigatorSequence = (name: string | undefined): number | undefined =>
  systemCallsignSequence('warden', name);
export const nextWardenInvestigatorSequence = nextSystemCallsignSequence;
const WardenBlessingViewSchema = z.object({
  sessionId: z.string().min(1),
  kinds: z.array(WardenAnomalyKindSchema),
  expiresAt: InstantSchema,
  by: WardenClearedBySchema,
  streak: PositiveIntegerSchema.optional(),
  untilChange: z.literal(true).optional(),
});
export type WardenBlessingView = z.infer<typeof WardenBlessingViewSchema>;
export const WardenStatusViewSchema = z.object({
  config: WardenConfigSchema,
  lastSweepAt: InstantSchema.optional(),
  nextSweepAt: InstantSchema.optional(),
  anomalies: z.array(WardenAnomalySchema),
  stuckInput: z.array(WardenStuckInputFlagSchema).optional(),
  stuckInbox: z.array(WardenStuckInboxFlagSchema).optional(),
  fingerprint: z.string(),
  liveWarden: z.string().optional(),
  lastSpawnAt: InstantSchema.optional(),
  lastReport: z.object({ reportId: z.string().min(1), head: z.string() }).optional(),
  failover: WardenFailoverStatusSchema.optional(),
  login: WardenLoginSchema.optional(),
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
export type WardenStatusView = z.infer<typeof WardenStatusViewSchema>;
const WardenRunViewSchema = z.object({
  sweptAt: InstantSchema,
  anomalies: z.array(WardenAnomalySchema),
  stuckInput: z.array(WardenStuckInputFlagSchema).optional(),
  stuckInbox: z.array(WardenStuckInboxFlagSchema).optional(),
  spawned: z.string().optional(),
  assignedWardens: z.array(z.string()).optional(),
  message: z.string().optional(),
});
export type WardenRunView = z.infer<typeof WardenRunViewSchema>;
const WardenInvestigateViewSchema = z.object({
  sessionId: z.string().min(1),
  state: z.enum(['queued', 'running']),
  position: PositiveIntegerSchema.optional(),
  wardenSession: z.string().min(1).optional(),
  message: z.string().min(1),
});
export type WardenInvestigateView = z.infer<typeof WardenInvestigateViewSchema>;
export type WardenLeaveDuration = z.infer<typeof WardenLeaveDurationSchema>;
const WardenLeaveViewSchema = z.object({
  blessing: WardenBlessingViewSchema,
  message: z.string().min(1),
});
export type WardenLeaveView = z.infer<typeof WardenLeaveViewSchema>;
const WardenJudgementStateSchema = z.enum(['judged', 'pending', 'queued', 'failed', 'none']);
const WardenJudgeProvenanceSchema = z.object({
  wardenSessionId: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  harness: z.string().optional(),
});
const WardenJudgementSchema = z.object({
  state: WardenJudgementStateSchema,
  verdict: WardenVerdictKindSchema.optional(),
  reason: z.string().min(1),
  judgedBy: WardenJudgeProvenanceSchema.optional(),
  at: InstantSchema.optional(),
  reportPath: z.string().min(1).optional(),
  recommendation: WardenRecommendationSchema.optional(),
  stale: z.boolean().optional(),
});
const FleetAgendaItemSchema = z.object({
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
const WardenAgendaOutcomeSchema = z.enum(['items', 'clean-sweep', 'degraded', 'no-sweep']);
export type WardenAgendaOutcome = z.infer<typeof WardenAgendaOutcomeSchema>;
const WardenAgendaViewSchema = z.object({
  generatedAt: InstantSchema,
  lastSweepAt: InstantSchema.optional(),
  outcome: WardenAgendaOutcomeSchema,
  wardenDegraded: z.object({ since: InstantSchema.optional(), reason: z.string().min(1) }).optional(),
  items: z.array(FleetAgendaItemSchema),
  boardsWithParseErrors: z.array(z.object({ sessionId: z.string().min(1), parseErrors: PositiveIntegerSchema })),
  verdictCoverage: z.object({ limit: PositiveIntegerSchema, truncated: z.boolean() }),
});
export type WardenAgendaView = z.infer<typeof WardenAgendaViewSchema>;

export * from './foreign.ts';
