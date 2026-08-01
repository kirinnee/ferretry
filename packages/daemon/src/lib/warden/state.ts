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

import { z } from 'zod';
import type { Blessing, BlessingStore } from './bless.ts';
import type { WardenAnomaly, WardenAnomalyKind } from './detect.ts';
import type { WardenFailoverState } from './failover.ts';
import { WardenFailoverPolicySchema, WardenSelectionReasonSchema } from './provenance.ts';
import type { WardenSessionStatus } from './types.ts';

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
  'provider_unavailable',
] as const satisfies readonly WardenAnomalyKind[];

const AnomalyKindSchema = z.enum(WARDEN_ANOMALY_KINDS);

const SessionStatusSchema = z.enum([
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
] as const satisfies readonly WardenSessionStatus[]);

const LedgerSchema = z.object({
  lastTranscriptAt: Instant.optional(),
  lastCounterAdvanceAt: Instant.optional(),
  lastTokenAdvanceAt: Instant.optional(),
  lastSubprocessAt: Instant.optional(),
  lastPaneChangeAt: Instant.optional(),
  subprocessSince: Instant.optional(),
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
}) satisfies z.ZodType<unknown, WardenAnomaly>;

const BlessingSchema = z.object({
  sessionId: z.string().min(1),
  kinds: z.array(AnomalyKindSchema),
  status: SessionStatusSchema,
  blessedAt: Instant,
  expiresAt: Instant,
  wardenId: z.string().min(1).optional(),
}) satisfies z.ZodType<unknown, Blessing>;

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
}

const AssignmentSchema = z.object({
  wardenId: z.string().min(1),
  spawnedAt: Instant,
  capability: z.string().min(1),
  kinds: z.array(AnomalyKindSchema),
  reportPath: z.string().min(1),
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
  /** Live assigned wardens, keyed by target session id. */
  readonly assignments?: Readonly<Record<string, WardenAssignmentRecord>>;
  /** When each target's assigned warden finished, starting its cooldown. */
  readonly assignedCooldowns?: Readonly<Record<string, string>>;
  /** Still-suspect targets no slot was free for. Persisted so a deferred
   *  investigation is never silently lost. */
  readonly assignedQueue?: readonly WardenAnomaly[];
  readonly failover?: WardenFailoverState;
}

const RuntimeStateSchema = z.object({
  lastSweepAt: Instant.optional(),
  lastSpawnAt: Instant.optional(),
  lastFingerprint: z.string().optional(),
  lastSpawnFingerprint: z.string().optional(),
  recoveryGeneration: z.number().int().min(0).optional(),
  lastAnomalies: z.array(AnomalySchema).optional(),
  blessings: z.record(z.string(), BlessingSchema).optional(),
  assignments: z.record(z.string(), AssignmentSchema).optional(),
  assignedCooldowns: z.record(z.string(), Instant).optional(),
  assignedQueue: z.array(AnomalySchema).optional(),
  failover: FailoverStateSchema.optional(),
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
