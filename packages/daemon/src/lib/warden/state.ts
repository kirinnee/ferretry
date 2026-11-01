/**
 * The warden's durable runtime state — everything one sweep must remember for
 * the next one.
 *
 * WHY IT IS DURABLE. Every field here damps something. The spawn gap, the
 * suppression fingerprint, the per-target cooldowns, the blessings and the
 * failover strikes all exist to stop the warden re-investigating a situation it
 * has already paid for. A daemon restart that dropped them would re-investigate
 * the entire fleet at once, on the machine that had just restarted — which is
 * exactly when it can least afford it.
 *
 * WHY IT IS PARSED, NOT TRUSTED. The document is JSON on the operator's disk. A
 * partial write, a hand edit or a version skew must degrade to "remember
 * nothing" rather than throw, because a warden that cannot read its state must
 * still sweep — and re-investigating is a cost, while refusing to supervise is a
 * fault. `parseWardenRuntimeState` therefore never rejects: it keeps what
 * validates and drops the rest.
 *
 * Pure: no IO, no clock, no globals.
 */

import {
  SessionStatusSchema,
  TaskRefSchema,
  WARDEN_INVESTIGATOR_MAX_SEQUENCE,
  type WardenAction,
  WardenActionSchema,
  WardenActorSchema,
  WardenClearedBySchema,
  type WardenDayStats,
  WardenDayStatsSchema,
  WardenGuardFailureCodeSchema,
  type WardenInvestigationOrigin,
  WardenInvestigationOriginSchema,
  WardenJevActsSchema,
  type WardenJevBefore,
  WardenJevBeforeSchema,
  WardenJevPathSchema,
  type WardenJevPathStep,
  WardenVerdictKindSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { BackoffStore, InvestigationBackoff } from './backoff.ts';
import type { Blessing, BlessingStore, ClearStreak, ClearStreakStore } from './bless.ts';
import type { WardenAnomaly, WardenAnomalyKind } from './detect.ts';
import type { WardenFailoverState } from './failover.ts';
import type { OrphanMemory } from './orphans.ts';
import { WardenFailoverPolicySchema, WardenSelectionReasonSchema } from './provenance.ts';
import type { OverdueMemory } from './report-overdue.ts';
import type { ReviveState } from './revive.ts';
import type { ReviveWatch } from './revive-watch.ts';
import type { WardenCostAverage, WardenGuardHealth, WardenInvestigationRecord, WardenTriageDay } from './triage.ts';

const Instant = z.string().min(1);

/**
 * The anomaly kinds this daemon's detector produces.
 *
 * Declared here rather than imported as a zod enum because `detect.ts` is the
 * pure classifier and owns the TYPE; the `satisfies` below is what keeps the two
 * from drifting — adding a kind to the detector without adding it here is a
 * compile error, which is the only way a queued anomaly of a new kind cannot
 * silently vanish on the next read.
 */
export const WARDEN_ANOMALY_KINDS = [
  'dead_monitor',
  'unattended_question',
  'abandoned_wreckage',
  'quota_reset_passed',
  'declared_wait_overdue',
  'peer_wait_unanswerable',
  'sus_thinking',
  'sus_subprocess',
  'agent_frozen',
  'provider_unavailable',
  'owner_request',
  'orphaned_card',
  'report_overdue',
] as const satisfies readonly WardenAnomalyKind[];

const AnomalyKindSchema = z.enum(WARDEN_ANOMALY_KINDS);

const LedgerSchema = z.object({
  lastTranscriptAt: Instant.optional(),
  lastCounterAdvanceAt: Instant.optional(),
  lastTokenAdvanceAt: Instant.optional(),
  lastSubprocessAt: Instant.optional(),
  lastPaneChangeAt: Instant.optional(),
  lastMeaningfulPaneAt: Instant.optional(),
  subprocessSince: Instant.optional(),
  subprocessKey: z.string().min(1).optional(),
});

const AnomalySchema = z.object({
  kind: AnomalyKindSchema,
  sessionId: z.string().min(1),
  fleetKey: z.string().optional(),
  provider: z.string().optional(),
  affectedSessionIds: z.array(z.string().min(1)).optional(),
  teammate: z.string().optional(),
  label: z.string().optional(),
  status: SessionStatusSchema,
  detail: z.string().min(1),
  since: Instant.optional(),
  idleMinutes: z.number().finite().min(0).optional(),
  assignedWarden: z.boolean().optional(),
  ledger: LedgerSchema.optional(),
  subject: z.string().min(1).optional(),
  task: TaskRefSchema.optional(),
}) satisfies z.ZodType<unknown, WardenAnomaly>;

const BackoffSchema = z.object({
  subject: z.string().min(1),
  count: z.number().int().min(1),
  lastAt: Instant,
  cleared: z.literal(true).optional(),
  jevActed: z
    .object({ action: WardenJevActsSchema.keyof(), at: Instant, subject: z.string().min(1), landsBy: Instant })
    .optional(),
}) satisfies z.ZodType<unknown, InvestigationBackoff>;

const BlessingSchema = z.object({
  sessionId: z.string().min(1),
  kinds: z.array(AnomalyKindSchema),
  status: SessionStatusSchema,
  blessedAt: Instant,
  expiresAt: Instant,
  wardenId: z.string().min(1).optional(),
  by: WardenClearedBySchema.optional(),
  streak: z.number().int().min(1).optional(),
  untilChange: z.literal(true).optional(),
}) satisfies z.ZodType<unknown, Blessing>;

const ClearStreakSchema = z.object({
  status: SessionStatusSchema,
  counts: z.partialRecord(AnomalyKindSchema, z.number().int().min(1)),
}) satisfies z.ZodType<unknown, ClearStreak>;

/**
 * One live assigned warden, keyed in the state by the TARGET it investigates.
 *
 * `capability` is an unguessable secret minted per assignment and exported only
 * into that warden's own terminal. It is what authorizes the warden to stop its
 * target and nothing else: a warden holding the daemon's ordinary scoped
 * credential must not be able to name someone else's session, so possession of
 * this secret — never a client-stated identity — is the authorization.
 */
export interface WardenAssignmentRecord {
  readonly wardenId: string;
  readonly spawnedAt: string;
  readonly capability: string;
  /** The anomaly kinds this warden was actually asked to judge. A sibling kind
   *  it was never shown stays visibly unjudged rather than borrowing its
   *  verdict. */
  readonly kinds: readonly WardenAnomalyKind[];
  readonly reportPath: string;
  /** The subject of the anomaly it was sent about, so its verdict is remembered against that subject. */
  readonly subject?: string;
}

const AssignmentSchema = z.object({
  wardenId: z.string().min(1),
  spawnedAt: Instant,
  capability: z.string().min(1),
  kinds: z.array(AnomalyKindSchema),
  reportPath: z.string().min(1),
  subject: z.string().min(1).optional(),
}) satisfies z.ZodType<unknown, WardenAssignmentRecord>;

const StrikeSchema = z.object({ count: z.number().int().min(0), lastAt: Instant, lastReason: z.string() });

const FailoverStateSchema = z.object({
  rrCursor: z.number().int().min(0).optional(),
  strikes: z.record(z.string(), StrikeSchema).optional(),
  demotedUntil: z.record(z.string(), Instant).optional(),
  lastSelection: z
    .object({
      agent: z.string().min(1),
      policy: WardenFailoverPolicySchema,
      at: Instant,
      reason: WardenSelectionReasonSchema,
    })
    .optional(),
  exhaustedSince: Instant.optional(),
}) satisfies z.ZodType<unknown, WardenFailoverState>;

const TriageDaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  flags: z.number().int().min(0),
  jevDecisions: z.number().int().min(0),
  jevSkips: z.number().int().min(0),
  jevActions: z.number().int().min(0).optional(),
  jevUsd: z.number().finite().min(0),
  jevHour: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/)
    .optional(),
  jevHourUsd: z.number().finite().min(0).optional(),
}) satisfies z.ZodType<unknown, WardenTriageDay>;

const InvestigationRecordSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(['session', 'fleet']),
  origin: WardenInvestigationOriginSchema,
  targetId: z.string().min(1).optional(),
  anomalyKind: AnomalyKindSchema.optional(),
  startedAt: Instant,
  finishedAt: Instant.optional(),
  reportPath: z.string().min(1),
  verdict: WardenVerdictKindSchema.optional(),
  costUsd: z.number().finite().min(0).optional(),
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  wardenName: z.string().min(1).optional(),
  jev: WardenJevBeforeSchema.optional(),
}) satisfies z.ZodType<unknown, WardenInvestigationRecord>;

const CostAverageSchema = z.object({
  count: z.number().int().min(0),
  totalUsd: z.number().finite().min(0),
}) satisfies z.ZodType<unknown, WardenCostAverage>;

const GuardHealthSchema = z.object({
  lastFailure: z.object({ code: WardenGuardFailureCodeSchema, at: Instant }).optional(),
  backoffUntil: Instant.optional(),
}) satisfies z.ZodType<unknown, WardenGuardHealth>;

/** Why a target is in the investigation queue, and since when. */
export interface WardenQueueEntryMeta {
  readonly queuedAt: string;
  readonly origin: WardenInvestigationOrigin;
  /** The owner's words, for an investigation the owner asked for. */
  readonly note?: string;
}

const QueueMetaSchema = z.object({
  queuedAt: Instant,
  origin: WardenInvestigationOriginSchema,
  note: z.string().min(1).optional(),
}) satisfies z.ZodType<unknown, WardenQueueEntryMeta>;

/**
 * The flags the live FLEET warden was sent about: while it runs they are being looked at, so none of
 * them is put in front of the owner as a Warden notification (`owner-routes.ts`). Cleared once that warden is gone and its report judges them.
 */
export interface WardenSweepCoverage {
  readonly wardenId: string;
  readonly reportPath: string;
  readonly anomalies: readonly { readonly sessionId: string; readonly kind: WardenAnomalyKind }[];
}

const SweepCoverageSchema = z.object({
  wardenId: z.string().min(1),
  reportPath: z.string().min(1),
  anomalies: z.array(z.object({ sessionId: z.string().min(1), kind: AnomalyKindSchema })),
}) satisfies z.ZodType<unknown, WardenSweepCoverage>;

/**
 * Jev's last hand-on of one standing flag: why it passed the flag on, and how sure it was.
 *
 * Kept so that a flag the owner has to decide says WHY in the Warden's own terms — "Jev was not sure
 * (42%)", "Jev would nudge it, but nudging alone is off" — instead of the bare fact that it is there.
 * It describes the flag only while that flag stands in the status it was handed on in
 * (`owner-routes.ts`); a stale entry is read as nothing and is dropped once the map is full.
 */
export interface WardenJevHandoff {
  readonly at: string;
  /** The status the ferret was in, as `passedOnKey` keys it: a change of status is a new situation. */
  readonly status: WardenAnomaly['status'];
  /** `JevEscalation` (`triage.ts`), kept as a string so a vocabulary change never loses the record. */
  readonly why: string;
  readonly confidence: number;
  /** The act Jev was sure of and the Warden could not carry out alone. */
  readonly recommends?: string;
  readonly reason?: string;
  readonly failure?: string;
  /** The decision tree's path (`jev-tree.ts`), root first: the facts the daemon saw and Jev's answers. */
  readonly path?: readonly WardenJevPathStep[];
  /** The node Jev was not sure enough of: the question the owner is asked. */
  readonly node?: string;
}

const JevHandoffSchema = z.object({
  at: Instant,
  status: SessionStatusSchema,
  why: z.string().min(1),
  confidence: z.number().min(0).max(1),
  recommends: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  failure: z.string().min(1).optional(),
  path: WardenJevPathSchema.optional(),
  node: z.string().min(1).max(64).optional(),
}) satisfies z.ZodType<unknown, WardenJevHandoff>;

/** How many hand-ons the state keeps: newest first, the rest dropped. */
export const WARDEN_JEV_HANDOFF_LIMIT = 200;

/** The key a hand-on is stored under: one per (ferret, kind), as the backoff keys its looks. */
export const jevHandoffKey = (sessionId: string, kind: string): string => `${sessionId}|${kind}`;

/** Record Jev's hand-on of one flag, replacing any earlier one for it, bounded newest first. */
export function recordJevHandoff(
  store: Readonly<Record<string, WardenJevHandoff>>,
  anomaly: Pick<WardenAnomaly, 'sessionId' | 'kind'>,
  handoff: WardenJevHandoff,
): Readonly<Record<string, WardenJevHandoff>> {
  const key = jevHandoffKey(anomaly.sessionId, anomaly.kind);
  const rest = Object.entries(store)
    .filter(([existing]) => existing !== key)
    .toSorted(([, left], [, right]) => right.at.localeCompare(left.at))
    .slice(0, WARDEN_JEV_HANDOFF_LIMIT - 1);
  return Object.fromEntries([[key, handoff], ...rest]);
}

/**
 * The days the state keeps, read entry by entry: one corrupt day costs that day, not the history —
 * and a document that is not a list at all costs only this section, through the per-section salvage.
 */
const DailySchema = z.array(z.unknown()).transform((entries): readonly WardenDayStats[] =>
  entries.flatMap(entry => {
    const parsed = WardenDayStatsSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }),
);

/** How many investigations and actions the state remembers beyond today's. */
export const WARDEN_HISTORY_LIMIT = 50;

/** Everything one sweep carries to the next. */
export interface WardenRuntimeState {
  readonly lastSweepAt?: string;
  readonly lastSpawnAt?: string;
  /** Fingerprint of the anomaly set the last sweep saw, for the recovery edge. */
  readonly lastFingerprint?: string;
  /** Generation-qualified fingerprint of the set the last ESCALATION covered. */
  readonly lastSpawnFingerprint?: string;
  /**
   * Bumped each time the fleet goes from having anomalies to having none.
   *
   * Escalation suppression is keyed on it, so an anomaly set that REAPPEARS
   * after a clean recovery escalates again instead of being silenced as
   * "unchanged since the last spawn". Without it, one fixed incident permanently
   * suppresses its own recurrence.
   */
  readonly recoveryGeneration?: number;
  /**
   * The anomaly set the last sweep found, so the status surface can answer
   * without re-measuring.
   *
   * In the state document rather than a file of its own because it has the same
   * durability requirement as everything else here and the same defensive read: a
   * status route that had to parse a second document would need a second fallback
   * policy for it, and "the anomalies file is corrupt" and "no sweep has run" must
   * not become the same answer.
   */
  readonly lastAnomalies?: readonly WardenAnomaly[];
  readonly blessings?: BlessingStore;
  /** How many times in a row each flag on a ferret was cleared, so the next clear lasts longer. */
  readonly clearStreaks?: ClearStreakStore;
  /** The flags Jev passed on that still stand (`passedOnKey` in `triage.ts`), so it is not asked about them again. */
  readonly passedOn?: readonly string[];
  /** The flags handed on unasked because Jev's cap was spent, already written down (`jev-checks.ts` {@link capSkipKey}). */
  readonly jevCapSkips?: readonly string[];
  /**
   * Jev's last word on each standing flag it did not settle (`jev-checks.ts`), keyed by {@link jevHandoffKey}:
   * what an investigation of that flag records as what Jev did first.
   */
  readonly jevBefore?: Readonly<Record<string, WardenJevBefore>>;
  /** Why Jev passed each flag on, keyed by {@link jevHandoffKey}: what the owner's notification says about it. */
  readonly jevHandoffs?: Readonly<Record<string, WardenJevHandoff>>;
  /**
   * The subjects the owner has been notified about (`escalation.ts`), with when, kept while each still has
   * a reason: reading a notification clears it, so this — not the board — is what stops a second one.
   */
  readonly notified?: Readonly<Record<string, string>>;
  /** Live assigned wardens, keyed by target session id. */
  readonly assignments?: Readonly<Record<string, WardenAssignmentRecord>>;
  /** When each target's assigned warden finished, starting its cooldown. */
  readonly assignedCooldowns?: Readonly<Record<string, string>>;
  /**
   * The looks already paid for, per (ferret, kind) and the subject they were about, so the next one
   * waits longer (`backoff.ts`). Added after the first release of this document: absent reads as none.
   */
  readonly backoff?: BackoffStore;
  /** Still-suspect targets no slot was free for. Persisted so a deferred
   *  investigation is never silently lost. */
  readonly assignedQueue?: readonly WardenAnomaly[];
  readonly failover?: WardenFailoverState;
  /** Today's Jev counters; reset at UTC midnight. */
  readonly triageDay?: WardenTriageDay;
  /** Investigations started, newest first: today's, plus up to {@link WARDEN_HISTORY_LIMIT} more. */
  readonly investigations?: readonly WardenInvestigationRecord[];
  readonly costAverage?: WardenCostAverage;
  readonly guard?: WardenGuardHealth;
  /** What the Warden did or holds for the owner, newest first, at most {@link WARDEN_HISTORY_LIMIT}. */
  readonly actions?: readonly WardenAction[];
  /** Why each queued target is queued, keyed by target session id. */
  readonly queueMeta?: Readonly<Record<string, WardenQueueEntryMeta>>;
  readonly sweepCoverage?: WardenSweepCoverage;
  /** The last 30 UTC days of the Warden's work, oldest first (`daily.ts`). Absent in a document that predates it. */
  readonly daily?: readonly WardenDayStats[];
  /** The sequence of the last investigator named `warden-xxxxxx`; the next one is issued after it. */
  readonly investigatorSequence?: number;
  /** What auto-revive remembers: who was revived and when, the breaker, the deaths already explained. */
  readonly revive?: ReviveState;
  /** Ferrets the Warden brought back that have not yet shown progress or run out of time (`revive-watch.ts`). */
  readonly reviveWatch?: readonly ReviveWatch[];
  /**
   * The orphaned cards the Warden told somebody about (`orphans.ts`), keyed by card id, kept while each
   * card stays orphaned by the same ferret: what stops it telling them again every sweep.
   */
  readonly orphans?: OrphanMemory;
  /**
   * The sub-ferrets the Warden nudged or whose parent it told about an unanswered message
   * (`report-overdue.ts`), keyed by session id, kept while each lives: what stops it repeating either.
   */
  readonly overdue?: OverdueMemory;
}

/**
 * The Warden's own memory of the sessions it revived (`revive.ts`). Each part is optional and defaulted on
 * read, so a document written before auto-revive existed reads as "never revived anything".
 */
const ReviveStateSchema = z.object({
  sessions: z
    .record(
      z.string(),
      z.object({
        revivedAt: Instant,
        attempts: z.number().int().min(0),
        crashRevives: z.number().int().min(0),
      }),
    )
    .default({}),
  batches: z.array(z.object({ at: Instant, ids: z.array(z.string().min(1)) })).default([]),
  breaker: z.object({ openedAt: Instant, until: Instant, why: z.string() }).optional(),
  refused: z.record(z.string(), Instant).default({}),
});

const ReviveWatchSchema = z.object({
  sessionId: z.string().min(1),
  at: Instant,
  actor: WardenActorSchema,
  action: z.enum(['revive', 'resume']),
});

const RuntimeStateSchema = z.object({
  lastSweepAt: Instant.optional(),
  lastSpawnAt: Instant.optional(),
  lastFingerprint: z.string().optional(),
  lastSpawnFingerprint: z.string().optional(),
  recoveryGeneration: z.number().int().min(0).optional(),
  lastAnomalies: z.array(AnomalySchema).optional(),
  blessings: z.record(z.string(), BlessingSchema).optional(),
  clearStreaks: z.record(z.string(), ClearStreakSchema).optional(),
  passedOn: z.array(z.string().min(1)).optional(),
  jevCapSkips: z.array(z.string().min(1)).optional(),
  jevBefore: z.record(z.string(), WardenJevBeforeSchema).optional(),
  jevHandoffs: z.record(z.string(), JevHandoffSchema).optional(),
  notified: z.record(z.string(), Instant).optional(),
  assignments: z.record(z.string(), AssignmentSchema).optional(),
  assignedCooldowns: z.record(z.string(), Instant).optional(),
  backoff: z.record(z.string(), BackoffSchema).optional(),
  assignedQueue: z.array(AnomalySchema).optional(),
  failover: FailoverStateSchema.optional(),
  triageDay: TriageDaySchema.optional(),
  investigations: z.array(InvestigationRecordSchema).optional(),
  costAverage: CostAverageSchema.optional(),
  guard: GuardHealthSchema.optional(),
  actions: z.array(WardenActionSchema).optional(),
  queueMeta: z.record(z.string(), QueueMetaSchema).optional(),
  sweepCoverage: SweepCoverageSchema.optional(),
  daily: DailySchema.optional(),
  investigatorSequence: z.number().int().min(0).max(WARDEN_INVESTIGATOR_MAX_SEQUENCE).optional(),
  revive: ReviveStateSchema.optional(),
  reviveWatch: z.array(ReviveWatchSchema).optional(),
  orphans: z
    .record(
      z.string(),
      z.object({
        assignee: z.string().min(1),
        via: z.enum(['owner', 'notice']),
        to: z.string().min(1),
        at: Instant,
      }),
    )
    .optional(),
  overdue: z
    .record(z.string(), z.object({ asked: Instant, nudgedAt: Instant.optional(), toldParentAt: Instant.optional() }))
    .optional(),
});

export const EMPTY_WARDEN_STATE: WardenRuntimeState = {};

/**
 * The state a persisted document means, never throwing.
 *
 * Each section is validated INDEPENDENTLY, so one corrupt blessing does not cost
 * the failover strikes. That matters in the direction of caution: strikes and
 * demotions are the record of accounts that have already failed, and dropping
 * them would send the next spawn straight back at a broken account, while
 * dropping a blessing only costs one extra investigation.
 */
export function parseWardenRuntimeState(value: unknown): WardenRuntimeState {
  if (typeof value !== 'object' || value === null) return EMPTY_WARDEN_STATE;
  const whole = RuntimeStateSchema.safeParse(value);
  if (whole.success) return whole.data as WardenRuntimeState;
  const record = value as Record<string, unknown>;
  const salvaged: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(RuntimeStateSchema.shape)) {
    if (record[key] === undefined) continue;
    const parsed = schema.safeParse(record[key]);
    if (parsed.success) salvaged[key] = parsed.data;
  }
  return salvaged as WardenRuntimeState;
}

/**
 * The suppression key for an escalation over `fingerprint`.
 *
 * Qualified by the recovery generation so the same anomaly set before and after
 * a clean sweep are DIFFERENT keys — see `recoveryGeneration`.
 */
export function spawnSuppressionKey(state: WardenRuntimeState, fingerprint: string): string {
  return `${state.recoveryGeneration ?? 0}:${fingerprint}`;
}

/**
 * Record the fingerprint this sweep observed, bumping the recovery generation on
 * the anomalies → none edge.
 *
 * The edge is one-directional on purpose: going from none to some is the
 * incident itself and needs no new generation, because there is no earlier
 * suppression key to escape.
 */
export function recordSweepFingerprint(state: WardenRuntimeState, fingerprint: string): WardenRuntimeState {
  const previous = state.lastFingerprint ?? '';
  const recovered = previous !== '' && fingerprint === '';
  return {
    ...state,
    lastFingerprint: fingerprint,
    ...(recovered ? { recoveryGeneration: (state.recoveryGeneration ?? 0) + 1 } : {}),
  };
}

/**
 * True when `capability` is the secret minted for this target's live assignment.
 *
 * The comparison is against the ASSIGNMENT, so a warden whose assignment has
 * been reconciled away — it finished, or its session vanished — immediately
 * stops being authorized, without any separate revocation step.
 */
export function wardenMayStop(state: WardenRuntimeState, capability: string, targetId: string): boolean {
  const expected = state.assignments?.[targetId]?.capability;
  return expected !== undefined && expected.length > 0 && expected === capability;
}
