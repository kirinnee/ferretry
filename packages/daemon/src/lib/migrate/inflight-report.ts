import type { SessionStatus } from '@ferretry/protocol';
import { verdictBlocksMigration, worstVerdict, type InflightVerdict } from './verdict.ts';

export interface OpenToolInfo {
  readonly toolUseId: string;
  readonly name: string;
  readonly summary: string;
  readonly startedAt?: string;
  readonly verdict: InflightVerdict;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly argv: string;
  readonly startedSecondsAgo?: number;
  readonly cwd?: string;
  readonly verdict: InflightVerdict;
}

/**
 * The outcome of walking a pane's process tree. A failed walk is deliberately a distinct case: an
 * inspection that could not run is not evidence that nothing is running, and collapsing the two
 * lets a destructive process be killed silently.
 */
export type ProcessObservation =
  | { readonly kind: 'observed'; readonly processes: readonly ProcessInfo[] }
  | { readonly kind: 'unobservable'; readonly reason: string };

export interface InflightReport {
  readonly status: SessionStatus;
  readonly turn: number;
  readonly empty: boolean;
  readonly openTools: readonly OpenToolInfo[];
  readonly processes: readonly ProcessInfo[];
  readonly codexBackgroundTerminals: number;
  readonly discrepancy: number;
  /** Everything the inspection could not rule out, in the order it was discovered. */
  readonly blindSpots: readonly string[];
  readonly worstVerdict: InflightVerdict;
  readonly subprocessSince?: string;
}

export interface AssembleInflightReportInput {
  readonly status: SessionStatus;
  readonly turn: number;
  readonly openTools: readonly OpenToolInfo[];
  readonly processes: ProcessObservation;
  readonly codexBackgroundTerminals: number;
  readonly subprocessSince?: string;
  /** Signals the caller itself could not read, contributed alongside the ones found here. */
  readonly blindSpots?: readonly string[];
}

const activeStatuses: ReadonlySet<SessionStatus> = new Set([
  'starting',
  'running',
  'thinking',
  'tool_running',
  'retrying',
]);

/**
 * Combines observable signals into a fail-closed migration safety report.
 *
 * A blind spot — an inspection that failed, or a session that reports work while the inspection
 * sees none — contributes an `unknown` verdict, because the gate must refuse what it cannot see.
 */
export function assembleInflightReport(input: AssembleInflightReportInput): InflightReport {
  const discrepancy = Math.max(0, input.codexBackgroundTerminals);
  const inspection = input.processes;
  const processes = inspection.kind === 'observed' ? inspection.processes : [];
  const blindSpots: string[] = [...(input.blindSpots ?? [])];
  if (inspection.kind === 'unobservable') blindSpots.push(inspection.reason);
  const claimsWork = activeStatuses.has(input.status) || input.subprocessSince !== undefined;
  const observedItems = input.openTools.length + processes.length + discrepancy;
  if (inspection.kind === 'observed' && claimsWork && observedItems === 0)
    blindSpots.push(`the session reports ${input.status} work but nothing was observable in its pane`);
  const verdicts: InflightVerdict[] = [
    ...input.openTools.map(tool => tool.verdict),
    ...processes.map(entry => entry.verdict),
  ];
  if (blindSpots.length > 0) verdicts.push('unknown');
  if (discrepancy > 0) verdicts.push('unknown');
  const hasInflight =
    input.openTools.length > 0 ||
    discrepancy > 0 ||
    processes.some(entry => entry.verdict !== 'safe_to_kill') ||
    input.subprocessSince !== undefined;
  return {
    status: input.status,
    turn: input.turn,
    empty: blindSpots.length === 0 && !activeStatuses.has(input.status) && !hasInflight,
    openTools: input.openTools,
    processes,
    codexBackgroundTerminals: discrepancy,
    discrepancy,
    blindSpots,
    worstVerdict: verdicts.length === 0 ? 'safe_to_kill' : worstVerdict(verdicts),
    subprocessSince: input.subprocessSince,
  };
}

export interface GateDecision {
  readonly proceed: boolean;
  readonly forced: boolean;
  readonly reason: string;
}

/**
 * Refuses an unsafe report unless the caller provides an explicit force decision.
 *
 * A blind spot is reported ahead of the verdict because "we could not look" and "we looked and
 * found something dangerous" demand different follow-up from whoever reads the refusal.
 */
export function gateInflight(report: InflightReport, options: { readonly force?: boolean } = {}): GateDecision {
  if (report.empty) return { proceed: true, forced: false, reason: 'no in-flight work' };
  if (!verdictBlocksMigration(report.worstVerdict))
    return { proceed: true, forced: false, reason: `in-flight work is ${report.worstVerdict}` };
  const cause = report.blindSpots[0] ?? `in-flight work is ${report.worstVerdict}`;
  if (options.force) return { proceed: true, forced: true, reason: `forced past ${cause}` };
  return { proceed: false, forced: false, reason: `refused: ${cause}` };
}
