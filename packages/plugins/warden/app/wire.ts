/**
 * The Warden wire as the app half reads it: the contract's own schemas and constants, plus the shapes of the parts the
 * contract types as loose objects (spend, savings, the daily statistics, the failover status, Jev's checks and what
 * Jev did before an investigation). Those are written out here, field for field what the daemon sends, because the UI
 * reads them; the contract keeps them loose until the strict schemas land with the code that writes them.
 *
 * Nothing here needs a ferret, a daemon connection or a browser.
 */

import type { FerretState } from '@ferretry/core-ferrets/contract';
import type { z } from 'zod';
import {
  DEFAULT_WARDEN_CONFIG,
  WARDEN_AUTO_MOVE_TRIGGERS,
  WARDEN_GUARD_THRESHOLD_RANGE,
  WARDEN_LEAVE_DURATIONS,
  WARDEN_SWEEP_INTERVALS,
  type WardenAccountSchema,
  type WardenActionKindSchema,
  type WardenClearedBySchema,
  type WardenConfig,
  type WardenSettingsPatchSchema,
  type WardenConfigView,
  type WardenFailoverPolicySchema,
  type WardenLayersSchema,
  type WardenLayerStatusSchema,
  type WardenLeaveDurationSchema,
  type WardenLoginViewSchema,
  type WardenMayActAloneSchema,
  type WardenTriageReasonSchema,
  type WardenVerdictKindSchema,
  type WardenAnomalyKindSchema,
  type WardenActionTallySchema,
  type WardenActorCountsSchema,
  type WardenCapSchema,
  type WardenDayStatsSchema,
  type WardenJevCheckSchema,
  type WardenJevCheckWhySchema,
  type WardenJevPathStepSchema,
  type WardenReviveResultsSchema,
  type WardenSavingsSchema,
  type WardenSpendSchema,
  type WardenStatActionSchema,
} from '../contract/index.ts';

export { DEFAULT_WARDEN_CONFIG, WARDEN_GUARD_THRESHOLD_RANGE, WARDEN_LEAVE_DURATIONS, WARDEN_SWEEP_INTERVALS };
export type { WardenConfig, WardenConfigView };
export type WardenAnomalyKind = z.infer<typeof WardenAnomalyKindSchema>;

// ─── settings ────────────────────────────────────────────────────────────────────────────────────────────────────
export type WardenConfigPatch = z.infer<typeof WardenSettingsPatchSchema>;
export type WardenAccount = z.infer<typeof WardenAccountSchema>;
export type WardenLayers = z.infer<typeof WardenLayersSchema>;
export type WardenMayActAlone = z.infer<typeof WardenMayActAloneSchema>;
export type WardenAutoMoveTrigger = (typeof WARDEN_AUTO_MOVE_TRIGGERS)[number];
export type WardenEffort = WardenConfig['investigation']['effort'];
export type WardenEventTrigger = keyof WardenConfig['events'];
export type WardenFailoverPolicy = z.infer<typeof WardenFailoverPolicySchema>;
export type WardenLeaveDuration = z.infer<typeof WardenLeaveDurationSchema>;
export type WardenLogin = z.infer<typeof WardenLoginViewSchema>;
export type WardenTriageReason = z.infer<typeof WardenTriageReasonSchema>;
type WardenLayerStatus = z.infer<typeof WardenLayerStatusSchema>;
export type WardenVerdictKind = z.infer<typeof WardenVerdictKindSchema>;
type WardenClearedBy = z.infer<typeof WardenClearedBySchema>;
export type WardenActionKind = z.infer<typeof WardenActionKindSchema>;

/** The settings sections the daemon merges key by key (a patch names only the keys that changed inside one). */
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

/** The limits the daemon's schema holds a setting to; the form checks against the same numbers. */
export const WARDEN_JEV_ACT_THRESHOLD_RANGE = { min: 0.3, max: 1 } as const;
/** How long the warden waits for a ferret to stop its background jobs before moving it, in minutes. */
export const WARDEN_AUTO_MOVE_WAIT_RANGE = { min: 1, max: 60 } as const;
/** How many times one ferret may be moved in an hour. */
export const WARDEN_AUTO_MOVE_MOVES_RANGE = { min: 1, max: 6 } as const;
/** How much of its tightest window a login must have left to be moved onto, in percent. 0 turns the floor off. */
export const WARDEN_AUTO_MOVE_HEADROOM_RANGE = { min: 0, max: 90 } as const;

// ─── what the routes answer ──────────────────────────────────────────────────────────────────────────────────────
// The contract brands a ferret id; the app reads it as the text it is, so these are the contract's shapes with the
// id as a plain string. Kept equal to `../contract/wire.ts`.

/** A flag: the warden noticing trouble on one ferret. */
export interface WardenFlag {
  readonly kind: WardenAnomalyKind;
  readonly ferret: string;
  readonly generation?: number;
  readonly provider?: string;
  readonly affectedFerrets?: readonly string[];
  readonly failureClasses?: readonly string[];
  readonly models?: readonly string[];
  readonly name?: string;
  readonly label?: string;
  readonly state: FerretState;
  readonly detail: string;
  readonly since?: string;
  readonly idleMinutes?: number;
  readonly assignedWarden?: boolean;
  readonly subject?: string;
  readonly card?: { readonly id: string };
}

export interface WardenBlessingView {
  readonly ferret: string;
  readonly kinds: readonly WardenAnomalyKind[];
  readonly expiresAt: string;
  readonly by: WardenClearedBy;
  readonly streak?: number;
  readonly untilChange?: true;
}

interface WardenRecommendation {
  readonly action: 'nudge' | 'stop' | 'resume' | 'restart' | 'move' | 'leave';
  readonly reason: string;
  readonly agent?: string;
}

/** What the warden ran on, when it wrote a verdict. */
interface WardenVerdictSpawn {
  readonly agent: string;
  readonly model: string;
  readonly [key: string]: unknown;
}

export interface WardenVerdict {
  readonly at: string;
  readonly target?: string;
  readonly name?: string;
  readonly label?: string;
  readonly anomalyKind?: WardenAnomalyKind;
  readonly verdict: WardenVerdictKind;
  readonly explicitNeedsHuman?: boolean;
  readonly recommendation?: WardenRecommendation;
  readonly reason?: string;
  readonly reportPath: string;
  readonly spawn?: WardenVerdictSpawn;
}

interface WardenJudgement {
  readonly state: 'judged' | 'pending' | 'queued' | 'failed' | 'none';
  readonly verdict?: WardenVerdictKind;
  readonly reason: string;
  readonly judgedBy?: {
    readonly warden?: string;
    readonly agent?: string;
    readonly model?: string;
    readonly harness?: string;
  };
  readonly at?: string;
  readonly reportPath?: string;
  readonly recommendation?: WardenRecommendation;
  readonly stale?: boolean;
}

export interface WardenAgendaItem {
  readonly ferret: string;
  readonly name?: string;
  readonly label?: string;
  readonly ferretState?: FerretState;
  readonly id: string;
  readonly source: 'card' | 'question' | 'agent-raised' | 'warden-flag' | 'warden-action';
  readonly subject: string;
  readonly why: string;
  readonly context?: string;
  readonly waitingSince: string;
  readonly howToResolve: string;
  readonly recommendation?: WardenRecommendation;
  readonly raisedBy?: 'human' | 'agent' | 'daemon';
  readonly raisedByName?: string;
  readonly judgement?: WardenJudgement;
  readonly fromFlag?: boolean;
  readonly provider?: string;
  readonly anomalyKind?: WardenAnomalyKind;
}

/** `GET /v1/warden/agenda`: who needs you, with the warden's judgement of each. */
export interface WardenAgendaView {
  readonly generatedAt: string;
  readonly lastSweepAt?: string;
  readonly outcome: 'items' | 'clean-sweep' | 'degraded' | 'no-sweep';
  readonly wardenDegraded?: { readonly since?: string; readonly reason: string };
  readonly items: readonly WardenAgendaItem[];
  readonly verdictCoverage: { readonly limit: number; readonly truncated: boolean };
}

export interface WardenRunView {
  readonly sweptAt: string;
  readonly flags: readonly WardenFlag[];
  readonly spawned?: string;
  readonly assignedWardens?: readonly string[];
  readonly message?: string;
}

export interface WardenInvestigateRequest {
  readonly ferret: string;
  readonly note?: string;
}

export interface WardenInvestigateView {
  readonly ferret: string;
  readonly state: 'queued' | 'running';
  readonly position?: number;
  readonly warden?: string;
  readonly message: string;
}

export interface WardenLeaveRequest {
  readonly ferret: string;
  readonly duration: WardenLeaveDuration;
}

export interface WardenLeaveView {
  readonly blessing: WardenBlessingView;
  readonly message: string;
}

// ─── actors and outcomes ─────────────────────────────────────────────────────────────────────────────────────────
/** Who decided an action: a rule (`auto`), Jev, an investigation (`llm`) or the owner. */
export type WardenActor = 'auto' | 'jev' | 'llm' | 'owner';
/** What an action came to, for the page's tiles. */
export type WardenOutcome = 'moved' | 'cleared' | 'stopped' | 'asked';
/** An action kind as the statistics count it: `escalate` is a notification to the owner. */
export type WardenStatActionKind = z.infer<typeof WardenStatActionSchema>;
export type WardenCap = z.infer<typeof WardenCapSchema>;

/** The revives, as the statistics count them: a revive or a resume. */
export const WARDEN_REVIVE_ACTIONS: readonly WardenStatActionKind[] = ['revive', 'resume'];
/** How long a revived ferret has to get moving before the revive counts as stalled. */
export const WARDEN_REVIVE_PROGRESS_MINUTES = 10;

export type WardenJevCheckWhy = z.infer<typeof WardenJevCheckWhySchema>;
type WardenJevAct = Exclude<WardenActionKind, 'bless' | 'close_leftover' | 'revive'>;

type WardenJevPathStep = z.infer<typeof WardenJevPathStepSchema>;

/** One check Jev made of a flag (the contract's: it names the ferret). */
export type WardenJevCheck = z.infer<typeof WardenJevCheckSchema>;

/** What Jev did about a flag before an investigation (or an act) that followed it. */
export interface WardenJevBefore {
  readonly verdict: 'handed_on' | 'skipped' | 'not_asked' | 'off';
  readonly why?:
    | WardenJevCheckWhy
    | 'owner_request'
    | 'forced'
    | 'not_judgeable'
    | 'backoff'
    | 'unredacted'
    | 'no_record';
  readonly act?: WardenJevAct;
  readonly at?: string;
  readonly confidence?: number;
  readonly costUsd?: number;
  readonly path?: readonly WardenJevPathStep[];
  readonly node?: string;
}

// ─── the status ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface WardenFailoverAccountView {
  readonly agent: string;
  readonly model?: string;
  readonly eligible: boolean;
  readonly reason?: string;
  readonly demotedUntil?: string;
  readonly strikes?: number;
  readonly quota?: {
    readonly fiveHourPercent?: number;
    readonly weeklyPercent?: number;
    readonly atLimit?: boolean;
    readonly authOk?: boolean;
  };
}

export interface WardenFailoverStatus {
  readonly policy: WardenFailoverPolicy;
  readonly failureThreshold: number;
  readonly cooldownMinutes: number;
  readonly accounts: readonly WardenFailoverAccountView[];
  readonly lastSelection?: {
    readonly agent: string;
    readonly policy: WardenFailoverPolicy;
    readonly at: string;
    readonly reason: string;
  };
  readonly exhaustedSince?: string;
}

type WardenGuardFailureCode =
  | 'not_set'
  | 'vault_damaged'
  | 'misconfigured'
  | 'rejected'
  | 'invalid_request'
  | 'too_large'
  | 'rate_limited'
  | 'overloaded'
  | 'provider_error'
  | 'timeout'
  | 'unreachable'
  | 'malformed'
  | 'unredacted';

interface WardenTriageStatus {
  readonly jev: WardenLayerStatus;
  readonly llm: WardenLayerStatus;
  readonly guardFailure?: { readonly code: WardenGuardFailureCode; readonly at: string };
  readonly guardBackoffUntil?: string;
}

type WardenSpend = z.infer<typeof WardenSpendSchema>;
type WardenSavings = z.infer<typeof WardenSavingsSchema>;

export interface WardenInvestigation {
  readonly id: string;
  readonly state: 'queued' | 'running' | 'done';
  readonly scope: 'ferret' | 'pack';
  readonly origin: 'sweep' | 'jev' | 'owner';
  readonly target?: string;
  readonly anomalyKind?: WardenAnomalyKind;
  readonly warden?: string;
  readonly queuedAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly reportPath?: string;
  readonly verdict?: WardenVerdictKind;
  readonly costUsd?: number;
  readonly agent?: string;
  readonly model?: string;
  readonly wardenName?: string;
  readonly jev?: WardenJevBefore;
}

export interface WardenAction {
  readonly at: string;
  readonly ferret: string;
  readonly action: WardenActionKind;
  readonly outcome: 'done' | 'held' | 'failed';
  readonly by: WardenClearedBy;
  readonly anomalyKind?: WardenAnomalyKind;
  readonly detail: string;
  readonly reportPath?: string;
  readonly confidence?: number;
  readonly reason?: string;
  readonly agent?: string;
  readonly fromAgent?: string;
  readonly actor?: WardenActor;
  readonly investigator?: string;
  readonly jev?: WardenJevBefore;
}

export type WardenActorCounts = z.infer<typeof WardenActorCountsSchema>;
export type WardenActionTally = z.infer<typeof WardenActionTallySchema>;
export type WardenReviveResults = z.infer<typeof WardenReviveResultsSchema>;
export type WardenDayStats = z.infer<typeof WardenDayStatsSchema>;

/** `GET /v1/warden/status`: the contract's view with the loose parts written out. */
export interface WardenStatusView {
  readonly config: WardenConfig;
  readonly lastSweepAt?: string;
  readonly nextSweepAt?: string;
  readonly flags: readonly WardenFlag[];
  readonly fingerprint: string;
  readonly liveWarden?: string;
  /** A ferret's view only: some Warden is investigating (its id is not the ferret's to know). */
  readonly wardenRunning?: boolean;
  readonly lastSpawnAt?: string;
  readonly lastReport?: { readonly reportId: string; readonly head: string };
  readonly failover?: WardenFailoverStatus;
  readonly login?: WardenLogin;
  readonly triage: WardenTriageStatus;
  /** Absent in a FERRET's view: the fleet aggregates are the owner's, so a ferret sees only the `triage` state. */
  readonly spend?: WardenSpend;
  readonly savings?: WardenSavings;
  readonly investigations: readonly WardenInvestigation[];
  readonly actions: readonly WardenAction[];
  readonly blessings: readonly WardenBlessingView[];
  readonly history?: readonly WardenDayStats[];
  readonly actionTotals?: readonly WardenActionTally[];
  readonly reviveTotals?: WardenReviveResults;
  readonly jevChecks?: readonly WardenJevCheck[];
}

// ─── pure helpers ────────────────────────────────────────────────────────────────────────────────────────────────

/** Who decided an action: the actor it recorded, else from what it carries. */
export function wardenActionActor(action: Pick<WardenAction, 'actor' | 'by' | 'reportPath'>): WardenActor {
  if (action.actor !== undefined) return action.actor;
  if (action.by === 'jev') return 'jev';
  if (action.by === 'owner') return 'owner';
  return action.reportPath === undefined ? 'auto' : 'llm';
}

const SYSTEM_CALLSIGN_PATTERN = /^(warden|learning|pack)-([0-9a-f]{6})$/iu;

/** `warden-00002a` becomes `warden-00002A`: the prefix as stored, the hex digits uppercase. Any other name unchanged. */
export function displaySystemCallsign(callsign: string): string {
  const match = SYSTEM_CALLSIGN_PATTERN.exec(callsign.trim());
  if (match?.[1] === undefined || match[2] === undefined) return callsign;
  const sequence = Number.parseInt(match[2], 16);
  if (sequence === 0) return callsign;
  return `${match[1].toLowerCase()}-${sequence.toString(16).toUpperCase().padStart(6, '0')}`;
}
