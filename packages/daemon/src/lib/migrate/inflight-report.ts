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

export interface InflightReport {
  readonly status: SessionStatus;
  readonly turn: number;
  readonly empty: boolean;
  readonly openTools: readonly OpenToolInfo[];
  readonly processes: readonly ProcessInfo[];
  readonly codexBackgroundTerminals: number;
  readonly discrepancy: number;
  readonly worstVerdict: InflightVerdict;
  readonly subprocessSince?: string;
}

export interface AssembleInflightReportInput {
  readonly status: SessionStatus;
  readonly turn: number;
  readonly openTools: readonly OpenToolInfo[];
  readonly processes: readonly ProcessInfo[];
  readonly codexBackgroundTerminals: number;
  readonly subprocessSince?: string;
}

const activeStatuses: ReadonlySet<SessionStatus> = new Set(['running', 'thinking', 'tool_running', 'retrying']);

/** Combines observable signals into a fail-closed migration safety report. */
export function assembleInflightReport(input: AssembleInflightReportInput): InflightReport {
  const discrepancy = Math.max(0, input.codexBackgroundTerminals);
  const verdicts: InflightVerdict[] = [
    ...input.openTools.map(tool => tool.verdict),
    ...input.processes.map(entry => entry.verdict),
  ];
  if (discrepancy > 0) verdicts.push('unknown');
  const hasInflight =
    input.openTools.length > 0 ||
    discrepancy > 0 ||
    input.processes.some(entry => entry.verdict !== 'safe_to_kill') ||
    input.subprocessSince !== undefined;
  return {
    status: input.status,
    turn: input.turn,
    empty: !activeStatuses.has(input.status) && !hasInflight,
    openTools: input.openTools,
    processes: input.processes,
    codexBackgroundTerminals: discrepancy,
    discrepancy,
    worstVerdict: verdicts.length === 0 ? 'safe_to_kill' : worstVerdict(verdicts),
    subprocessSince: input.subprocessSince,
  };
}

export interface GateDecision {
  readonly proceed: boolean;
  readonly forced: boolean;
  readonly reason: string;
}

/** Refuses an unsafe report unless the caller provides an explicit force decision. */
export function gateInflight(report: InflightReport, options: { readonly force?: boolean } = {}): GateDecision {
  if (report.empty) return { proceed: true, forced: false, reason: 'no in-flight work' };
  if (!verdictBlocksMigration(report.worstVerdict))
    return { proceed: true, forced: false, reason: `in-flight work is ${report.worstVerdict}` };
  if (options.force)
    return { proceed: true, forced: true, reason: `forced past ${report.worstVerdict} in-flight work` };
  return { proceed: false, forced: false, reason: `refused: in-flight work is ${report.worstVerdict}` };
}
