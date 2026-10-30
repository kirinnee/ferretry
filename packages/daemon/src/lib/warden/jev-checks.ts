/**
 * Jev's checks: one record per flag Jev was put to, kept beside the reports, and counted into the day.
 *
 * WHY THIS EXISTS. On 2026-10-29 Jev answered 102 flags and the Warden page said it did nothing: every
 * answer was "not sure", so every flag went on to an investigation, and the day's outcomes (`daily.ts`)
 * count only what became of a flag — moved, cleared, stopped, asked. A flag Jev handed on is still a flag
 * Jev looked at, and what it cost is real; a check that leaves no trace is a layer nobody can judge.
 *
 * WHAT IS KEPT. The ferret, the flag, what Jev made of it, how sure it was, what it cost and when — and
 * nothing else: no reason, no transcript, no screen. Jev's reason is written from the transcript it was
 * shown, so it stays out of a record that lives on disk for a month.
 *
 * ONE RECORD PER CHECK, NOT PER SWEEP. Jev is asked once per standing flag (`triage.ts`), so a check is
 * written once. A flag skipped because the cap is spent is handed on again every sweep without a call;
 * it is written once while it stands ({@link capSkipKey}), not every sweep.
 *
 * Bounded: one file per UTC day, the last {@link JEV_CHECK_KEEP_DAYS} kept.
 *
 * Pure: no IO, no clock, no globals.
 */

import {
  type WardenDayStats,
  type WardenJevCheck,
  WardenJevCheckSchema,
  type WardenJevCheckRoute,
  type WardenJevDayStats,
} from '@ferretry/protocol';
import type { TriageDecision } from '../speedups/jev.ts';
import type { WardenAnomaly } from './detect.ts';
import { instantMs } from './time.ts';
import type { WardenGuardOutcome } from './triage.ts';

/** How many UTC days of checks are kept, today included. */
export const JEV_CHECK_KEEP_DAYS = 30;

/** How many of the newest checks the status carries. */
export const JEV_CHECKS_SHOWN = 50;

/** Where Jev's checks are written: one JSON line each, appended, rotated by the day. */
export interface WardenJevCheckLog {
  append(check: WardenJevCheck): Promise<void>;
  /** The newest checks first, at most `limit`. Empty when none were ever written. */
  recent(limit: number): Promise<readonly WardenJevCheck[]>;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const DAY_MS = 86_400_000;

/** The file one UTC day's checks are appended to. */
export const jevCheckFileName = (day: string): string => `${day}.jsonl`;

/** The day a check file holds, or `undefined` for a name that is not one. */
export function jevCheckFileDay(name: string): string | undefined {
  return DAY_FILE.exec(name)?.[1];
}

/** The check files older than the last {@link JEV_CHECK_KEEP_DAYS} days before `nowMs`, by name. */
export function expiredJevCheckFiles(names: readonly string[], nowMs: number): readonly string[] {
  const oldest = new Date(nowMs - (JEV_CHECK_KEEP_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  return names.filter(name => {
    const day = jevCheckFileDay(name);
    return day !== undefined && day < oldest;
  });
}

/** The check files to read for the newest checks: newest day first. */
export function jevCheckFilesNewestFirst(names: readonly string[]): readonly string[] {
  return names.filter(name => jevCheckFileDay(name) !== undefined).toSorted((left, right) => right.localeCompare(left));
}

/** One check as the line it is appended as. */
export const jevCheckLine = (check: WardenJevCheck): string => `${JSON.stringify(check)}\n`;

/** One day file's checks, newest first. A torn or foreign line costs that line, never the file. */
export function parseJevCheckLines(text: string): readonly WardenJevCheck[] {
  return text
    .split('\n')
    .flatMap(line => {
      if (line.trim() === '') return [];
      try {
        const parsed = WardenJevCheckSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    })
    .toReversed();
}

/** Jev's answer about one flag, and what the Warden did with it. */
export interface JevCheckInput {
  readonly anomaly: Pick<WardenAnomaly, 'sessionId' | 'kind'>;
  readonly decision: TriageDecision;
  readonly outcome: WardenGuardOutcome;
  /** Where a hand-on goes: an investigation while that layer can take one, the owner otherwise. */
  readonly route: WardenJevCheckRoute;
  /** For an act: whether it took. An act that did not take hands the flag on. */
  readonly took?: boolean;
  readonly nowMs: number;
}

/** The record of one check Jev made. */
export function jevCheckOf(input: JevCheckInput): WardenJevCheck {
  const { anomaly, decision, outcome, route, nowMs } = input;
  const base = {
    at: new Date(nowMs).toISOString(),
    sessionId: anomaly.sessionId,
    anomalyKind: anomaly.kind,
    confidence: outcome.confidence,
    costUsd: decision.costUsd ?? 0,
  };
  switch (outcome.kind) {
    case 'leave':
      return { ...base, verdict: 'healthy' };
    case 'act':
      return input.took === true
        ? { ...base, verdict: 'acted', act: outcome.act }
        : { ...base, verdict: 'handed_on', act: outcome.act, why: 'act_failed', route };
    case 'escalate':
      return {
        ...base,
        verdict: 'handed_on',
        why: outcome.why,
        route,
        ...(outcome.recommends === undefined ? {} : { act: outcome.recommends }),
      };
  }
}

/** The record of a flag Jev was not asked about because its cap — the day's, or this hour's share — was spent. */
export function jevCapSkipOf(
  anomaly: Pick<WardenAnomaly, 'sessionId' | 'kind'>,
  why: 'jev_cap' | 'jev_paced',
  route: WardenJevCheckRoute,
  nowMs: number,
): WardenJevCheck {
  return {
    at: new Date(nowMs).toISOString(),
    sessionId: anomaly.sessionId,
    anomalyKind: anomaly.kind,
    verdict: 'skipped',
    why,
    route,
    confidence: 0,
    costUsd: 0,
  };
}

/** Identity of one flag skipped for the cap: written once while it stands in the same status. */
export const capSkipKey = (anomaly: Pick<WardenAnomaly, 'kind' | 'sessionId' | 'status'>, day: string): string =>
  `${day}\u0000${anomaly.kind}\u0000${anomaly.sessionId}\u0000${anomaly.status}`;

/** A day with no check counted yet. */
export const EMPTY_JEV_DAY: WardenJevDayStats = { checks: 0, healthy: 0, acted: 0, handedOn: 0, skippedForCap: 0 };

/** One check counted into its day's funnel. */
export function countJevCheck(day: WardenDayStats, check: WardenJevCheck): WardenDayStats {
  const jev = day.jev ?? EMPTY_JEV_DAY;
  switch (check.verdict) {
    case 'healthy':
      return { ...day, jev: { ...jev, checks: jev.checks + 1, healthy: jev.healthy + 1 } };
    case 'acted':
      return { ...day, jev: { ...jev, checks: jev.checks + 1, acted: jev.acted + 1 } };
    case 'handed_on':
      return { ...day, jev: { ...jev, checks: jev.checks + 1, handedOn: jev.handedOn + 1 } };
    case 'skipped':
      return { ...day, jev: { ...jev, skippedForCap: jev.skippedForCap + 1 } };
  }
}

/** The UTC day a check was made on, or `undefined` for an instant that does not parse. */
export function jevCheckDay(check: Pick<WardenJevCheck, 'at'>): string | undefined {
  const at = instantMs(check.at);
  return at === undefined ? undefined : new Date(at).toISOString().slice(0, 10);
}

/**
 * The cap skips still worth remembering: today's, for flags that still stand in the same status. A flag
 * that goes and comes back, a ferret that changes status, or a new day (a fresh cap) is a new skip.
 */
export function pruneCapSkips(
  keys: readonly string[],
  standing: readonly Pick<WardenAnomaly, 'kind' | 'sessionId' | 'status'>[],
  nowMs: number,
): readonly string[] {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const live = new Set(standing.map(anomaly => capSkipKey(anomaly, day)));
  return keys.filter(key => live.has(key));
}
