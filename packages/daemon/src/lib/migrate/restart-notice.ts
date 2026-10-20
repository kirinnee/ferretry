import { ferretryNotice } from '@ferretry/protocol';
import { isBusyStatus, type InflightReport } from './inflight-report.ts';

/**
 * How many things the restart interrupted that are NOT known safe to lose: open tool calls and
 * processes that are not classified `safe_to_kill`, plus codex background terminals. A tool call
 * and the process it spawned are one command, so the larger of the two counts, not their sum.
 */
export function interruptedCount(report: InflightReport): number {
  const tools = report.openTools.filter(tool => tool.verdict !== 'safe_to_kill').length;
  const processes = report.processes.filter(entry => entry.verdict !== 'safe_to_kill').length;
  return Math.max(tools, processes) + report.codexBackgroundTerminals;
}

function headline(interrupted: number): string {
  if (interrupted === 0) return 'Restarted mid-turn — what was running could not be checked.';
  return `Restarted mid-turn — ${interrupted} ${interrupted === 1 ? 'command was' : 'commands were'} interrupted.`;
}

/**
 * The message sent to a restarted agent, or `undefined` when there is nothing worth saying.
 *
 * Restart and same-harness migrate resume the same conversation, so the agent already knows what it
 * was doing. It is told only when the session was mid-turn AND the inventory holds something not
 * known safe to lose — a blind spot counts, because "could not look" is not "nothing there". It is
 * a Ferretry notice, so the transcript draws it as a system row and the agent reads that it did not
 * come from the owner.
 */
export function restartNotice(report: InflightReport, reportPath: string): string | undefined {
  if (!isBusyStatus(report.status)) return undefined;
  const interrupted = interruptedCount(report);
  if (interrupted === 0 && report.blindSpots.length === 0) return undefined;
  return ferretryNotice(
    `${headline(interrupted)}\n\n` +
      `This notice is from Ferretry, not from the owner. Before re-running anything, read ${reportPath}: ` +
      'it lists what was running and what to check.',
  );
}
