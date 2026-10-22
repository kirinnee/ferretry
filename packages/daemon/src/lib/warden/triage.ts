/**
 * The TRIAGE tier: what happens to a flag between the free sweep and the expensive investigation, and
 * the daily budget that bounds it.
 *
 * ═══ JEV IS ONLY A GUARD ═══
 *
 * Jev answers one question about a flag — "is this worth a full investigation?" — and its whole
 * vocabulary is `skip` or `investigate`. It never acts on a ferret. A skip is believed only at or above
 * the owner's threshold; anything else, a failure included, is an investigation. So a broken, unsure or
 * unreachable guard costs money and never hides a stuck ferret — the doctrine's direction: on missing
 * evidence, refuse to bless. With investigations off, "investigate" means the owner is shown the flag.
 *
 * ═══ NO UNATTENDED SPEND BY SURPRISE ═══
 *
 * The rules are always on and spend nothing; Jev and investigations are each an opt-in LAYER with a
 * daily cap counted per UTC day. A cap that is reached turns off its own layer until midnight, and the
 * status says so. An investigation is priced from its own transcript after it finishes, so while one is
 * still unpriced its cost is estimated from the average of the ones that were — an estimate used only
 * to GATE, never shown as spend.
 *
 * ═══ JEV IS ASKED ONCE PER FLAG ═══
 *
 * A flag Jev passed on is remembered for as long as it persists in the same status
 * ({@link passedOnKey}), so a flag that waits for the owner — or for a free slot — is not paid for
 * again every sweep.
 *
 * Pure: no IO, no clock, no globals.
 */

import type {
  WardenCaps,
  WardenGuardFailureCode,
  WardenInvestigationOrigin,
  WardenSavings,
  WardenSpend,
  WardenCap,
  WardenLayers,
  WardenLayerStatus,
  WardenTriageReason,
} from '@ferretry/protocol';
import type { TriageDecision, TriageSnapshot } from '../speedups/jev.ts';
import { type WardenAnomaly, type WardenAnomalyKind, wardenAnomalySubject } from './detect.ts';
import { instantMs } from './time.ts';
import type { WardenVerdictKind } from './verdicts.ts';

const HOUR_MS = 3_600_000;

/** The UTC calendar day an instant falls on, `YYYY-MM-DD`: the day every cap counts against. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Today's Jev counters. Investigations are counted from their own records, so they cannot drift. */
export interface WardenTriageDay {
  readonly day: string;
  /** Flags that appeared this day: a (session, kind) pair absent from the sweep before. */
  readonly flags: number;
  readonly jevDecisions: number;
  readonly jevSkips: number;
  readonly jevUsd: number;
}

/** One investigation the Warden started, kept so its cost can be priced once analytics has read it. */
export interface WardenInvestigationRecord {
  /** The warden's own session id. */
  readonly id: string;
  readonly scope: 'session' | 'fleet';
  readonly origin: WardenInvestigationOrigin;
  readonly targetId?: string;
  readonly anomalyKind?: WardenAnomalyKind;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly reportPath: string;
  readonly verdict?: WardenVerdictKind;
  readonly costUsd?: number;
  readonly agent?: string;
  readonly model?: string;
}

/** Every priced investigation ever, as a running total, so the savings line can say what one costs. */
export interface WardenCostAverage {
  readonly count: number;
  readonly totalUsd: number;
}

/** The guard's own health: the last failure, and a back-off a rate limit or an overload asked for. */
export interface WardenGuardHealth {
  readonly lastFailure?: { readonly code: WardenGuardFailureCode; readonly at: string };
  readonly backoffUntil?: string;
}

export const EMPTY_TRIAGE_DAY = (day: string): WardenTriageDay => ({
  day,
  flags: 0,
  jevDecisions: 0,
  jevSkips: 0,
  jevUsd: 0,
});

/** Today's counters, started afresh when the stored ones belong to an earlier day. */
export function triageDayFor(stored: WardenTriageDay | undefined, nowMs: number): WardenTriageDay {
  const day = utcDay(nowMs);
  return stored?.day === day ? stored : EMPTY_TRIAGE_DAY(day);
}

/** The average priced investigation, or `undefined` when none has ever been priced. */
export function averageInvestigationUsd(average: WardenCostAverage | undefined): number | undefined {
  return average === undefined || average.count === 0 ? undefined : average.totalUsd / average.count;
}

/** Investigations that STARTED on the given UTC day. */
function startedOn(records: readonly WardenInvestigationRecord[], day: string): readonly WardenInvestigationRecord[] {
  return records.filter(record => {
    const at = instantMs(record.startedAt);
    return at !== undefined && utcDay(at) === day;
  });
}

/** Investigations started within the hour before `nowMs`. */
export function investigationsInLastHour(records: readonly WardenInvestigationRecord[], nowMs: number): number {
  return records.filter(record => {
    const at = instantMs(record.startedAt);
    return at !== undefined && at > nowMs - HOUR_MS && at <= nowMs;
  }).length;
}

export interface WardenSpendInput {
  readonly caps: WardenCaps;
  readonly today: WardenTriageDay;
  readonly records: readonly WardenInvestigationRecord[];
  readonly average?: WardenCostAverage;
  readonly nowMs: number;
}

/**
 * Today's spend against both caps. Either, both or neither may be hit: each is its own layer's.
 *
 * An unpriced investigation is gated at the average priced one: it has happened and it will cost
 * something, and gating it at zero would let a run of unpriced investigations walk straight past the
 * cap. With no priced investigation ever, it gates at zero and the hourly limit is what bounds it.
 */
export function wardenSpend(input: WardenSpendInput): WardenSpend {
  const today = startedOn(input.records, input.today.day);
  const investigationUsd = today.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
  const pending = today.filter(record => record.costUsd === undefined).length;
  const estimate = investigationUsd + pending * (averageInvestigationUsd(input.average) ?? 0);
  const capsHit: WardenCap[] = [
    ...(input.today.jevUsd >= input.caps.jevUsdPerDay ? (['jev'] as const) : []),
    ...(estimate >= input.caps.investigationUsdPerDay ? (['investigation'] as const) : []),
  ];
  return {
    day: input.today.day,
    jevUsd: input.today.jevUsd,
    jevCapUsd: input.caps.jevUsdPerDay,
    investigationUsd,
    investigationCapUsd: input.caps.investigationUsdPerDay,
    pendingInvestigations: pending,
    capsHit,
    investigationsLastHour: investigationsInLastHour(input.records, input.nowMs),
    maxInvestigationsPerHour: input.caps.maxInvestigationsPerHour,
  };
}

/** Each layer in effect right now, with the reason it is off when the owner switched it on. */
export interface WardenLayersInEffect {
  readonly jev: WardenLayerStatus;
  readonly llm: WardenLayerStatus;
}

/** A layer as configured, switched off for `off` when that is set. */
function layerStatus(configured: boolean, off: WardenTriageReason | undefined): WardenLayerStatus {
  if (!configured) return { configured, active: false, reason: 'configured' };
  return off === undefined
    ? { configured, active: true, reason: 'configured' }
    : { configured, active: false, reason: off };
}

/**
 * The layers actually in effect.
 *
 * EACH CAP TURNS OFF ONLY ITS OWN LAYER. The Jev cap stops Jev and leaves investigations to look at
 * every flag; the investigation cap stops investigations and leaves Jev clearing what it can, so the
 * owner is shown only the flags Jev did not. The rules underneath cost nothing and never stop. With no
 * usable investigation login an investigation has nothing to run on, so that layer is off as
 * `no_login` rather than spent on a name this machine does not have. Jev needs no login.
 */
export function effectiveLayers(
  layers: WardenLayers,
  enabled: boolean,
  spend: Pick<WardenSpend, 'capsHit'>,
  hasLogin = true,
): WardenLayersInEffect {
  const jevOff = !enabled ? 'disabled' : spend.capsHit.includes('jev') ? 'jev_cap' : undefined;
  const llmOff = !enabled
    ? 'disabled'
    : !hasLogin
      ? 'no_login'
      : spend.capsHit.includes('investigation')
        ? 'investigation_cap'
        : undefined;
  return { jev: layerStatus(layers.jev, jevOff), llm: layerStatus(layers.llm, llmOff) };
}

/** What the guard's answer means for one flag, after the owner's threshold. */
export type WardenGuardOutcome =
  | { readonly kind: 'skip'; readonly confidence: number }
  | { readonly kind: 'investigate'; readonly confidence: number; readonly failure?: WardenGuardFailureCode };

/**
 * A skip is believed only at or above the threshold. Below it — and on any failure — Jev's answer is
 * an investigation: when the guard is unsure, it fails toward looking.
 */
export function guardOutcome(decision: TriageDecision, threshold: number): WardenGuardOutcome {
  if (decision.failure !== undefined) return { kind: 'investigate', confidence: 0, failure: decision.failure.code };
  if (decision.verdict === 'skip' && decision.confidence >= threshold)
    return { kind: 'skip', confidence: decision.confidence };
  return { kind: 'investigate', confidence: decision.confidence };
}

/** The failures that ask the guard to wait before it is called again. */
const BACKOFF_CODES: ReadonlySet<WardenGuardFailureCode> = new Set(['rate_limited', 'overloaded']);

/** How long to leave the guard alone when the provider did not say. */
export const DEFAULT_GUARD_BACKOFF_MS = 60_000;

/**
 * The guard's health after one decision. A real answer clears the last failure; a rate limit or an
 * overload starts a back-off — the provider's own `retry-after` when it sent one — during which flags
 * go straight to investigation rather than hammering it.
 */
export function guardHealthAfter(
  health: WardenGuardHealth,
  decision: TriageDecision,
  nowMs: number,
): WardenGuardHealth {
  const failure = decision.failure;
  if (failure === undefined) return {};
  const at = new Date(nowMs).toISOString();
  const backoffMs = BACKOFF_CODES.has(failure.code) ? (failure.retryAfterMs ?? DEFAULT_GUARD_BACKOFF_MS) : undefined;
  return {
    ...health,
    lastFailure: { code: failure.code, at },
    ...(backoffMs === undefined ? {} : { backoffUntil: new Date(nowMs + backoffMs).toISOString() }),
  };
}

/** True while a back-off the provider asked for is still running. */
export function guardBackingOff(health: WardenGuardHealth, nowMs: number): boolean {
  const until = instantMs(health.backoffUntil);
  return until !== undefined && until > nowMs;
}

/** Count one decision into today's counters. */
export function recordGuardDecision(
  today: WardenTriageDay,
  decision: TriageDecision,
  outcome: WardenGuardOutcome,
): WardenTriageDay {
  return {
    ...today,
    jevDecisions: today.jevDecisions + (decision.failure === undefined ? 1 : 0),
    jevSkips: today.jevSkips + (outcome.kind === 'skip' ? 1 : 0),
    jevUsd: today.jevUsd + (decision.costUsd ?? 0),
  };
}

/**
 * Flags that are new this sweep: a (session, kind) pair the previous sweep did not see. A flag that
 * persists across sweeps is counted once, which is what "N flags today" means to a person.
 */
export function newFlagCount(previous: readonly WardenAnomaly[], current: readonly WardenAnomaly[]): number {
  const seen = new Set(previous.map(anomaly => `${anomaly.kind}\u0000${anomaly.sessionId}`));
  return current.filter(anomaly => !seen.has(`${anomaly.kind}\u0000${anomaly.sessionId}`)).length;
}

/** Today's savings line. `savedUsd` exists only when an investigation has ever been priced. */
export function wardenSavings(
  today: WardenTriageDay,
  records: readonly WardenInvestigationRecord[],
  average: WardenCostAverage | undefined,
): WardenSavings {
  const avg = averageInvestigationUsd(average);
  return {
    day: today.day,
    flags: today.flags,
    jevDecisions: today.jevDecisions,
    jevSkips: today.jevSkips,
    investigations: startedOn(records, today.day).length,
    ...(avg === undefined
      ? {}
      : { averageInvestigationUsd: avg, savedUsd: Math.max(0, today.jevSkips * avg - today.jevUsd) }),
  };
}

// ── The snapshot Jev is shown ────────────────────────────────────────────────────────────────────

/** What the daemon can read about a flagged ferret: its recent turns and its screen tail. */
export interface WardenTriageEvidence {
  readonly recentTurns: readonly string[];
  readonly paneTail?: string;
}

/**
 * The flag as Jev sees it, BEFORE redaction: the kind, the sweep's own sentence, a few scalar facts and
 * the evidence. Deliberately narrow — no paths, no ids beyond what the sentence already names.
 */
export function triageSnapshotOf(anomaly: WardenAnomaly, evidence: WardenTriageEvidence): TriageSnapshot {
  const facts: Record<string, string | number | boolean> = {
    subject: wardenAnomalySubject(anomaly.kind),
    status: anomaly.status,
    ...(anomaly.idleMinutes === undefined ? {} : { idleMinutes: anomaly.idleMinutes }),
    ...(anomaly.since === undefined ? {} : { since: anomaly.since }),
    ...(anomaly.affectedSessionIds === undefined ? {} : { affectedSessions: anomaly.affectedSessionIds.length }),
    ...(anomaly.provider === undefined ? {} : { provider: anomaly.provider }),
  };
  return {
    anomaly: anomaly.kind,
    summary: anomaly.detail,
    facts,
    recentTurns: evidence.recentTurns,
    ...(evidence.paneTail === undefined ? {} : { paneTail: evidence.paneTail }),
  };
}

/** The vault redactor, as narrow as the snapshot needs. It THROWS when the vault cannot be opened. */
export interface WardenTextRedactor {
  /** Every string of one snapshot under ONE vault open; `scrub` is valid only while `work` runs. */
  batch<T>(work: (scrub: { text(text: string): string }) => T): Promise<T>;
}

/**
 * Every string in the snapshot through the vault redactor, so a secret that reached a transcript or a
 * screen is masked before anything leaves the machine. A redactor that fails propagates its error:
 * text that cannot be scrubbed is text that must not be sent.
 */
export async function redactTriageSnapshot(
  snapshot: TriageSnapshot,
  redactor: WardenTextRedactor,
): Promise<TriageSnapshot> {
  return await redactor.batch(scrub => {
    const facts: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(snapshot.facts))
      facts[key] = typeof value === 'string' ? scrub.text(value) : value;
    return {
      anomaly: snapshot.anomaly,
      summary: scrub.text(snapshot.summary),
      facts,
      recentTurns: snapshot.recentTurns.map(turn => scrub.text(turn)),
      ...(snapshot.paneTail === undefined ? {} : { paneTail: scrub.text(snapshot.paneTail) }),
    };
  });
}

// ── Flags Jev passed on ──────────────────────────────────────────────────────────────────────────

/** Identity of one flag Jev passed on: its kind, its ferret, and the status the ferret was in. */
export function passedOnKey(anomaly: Pick<WardenAnomaly, 'kind' | 'sessionId' | 'status'>): string {
  return `${anomaly.kind}\u0000${anomaly.sessionId}\u0000${anomaly.status}`;
}

/**
 * The flags Jev passed on that still stand. A flag that is gone, or whose ferret changed status, is a
 * new situation: if it comes back, Jev is asked again.
 */
export function prunePassedOn(passedOn: readonly string[], current: readonly WardenAnomaly[]): readonly string[] {
  const standing = new Set(current.map(passedOnKey));
  return passedOn.filter(key => standing.has(key));
}

/** Forget what Jev said about one ferret: an investigation is about to look at it for itself. */
export function forgetPassedOn(passedOn: readonly string[], sessionId: string): readonly string[] {
  return passedOn.filter(key => key.split('\u0000')[1] !== sessionId);
}
