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

function quietNotice(): string {
  return ferretryNotice(
    'Restarted — nothing was interrupted.\n\n' +
      'This notice is from Ferretry, not from the owner. Your conversation was resumed as it was; ' +
      'there is nothing to re-run.',
  );
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
 *
 * AN AUTO SESSION IS THE ONE EXCEPTION to "send nothing": a resume with no message makes the resume
 * domain type its default "continue the assigned task" prompt, which would restart work an idle
 * session had finished. It is sent a one-line notice that nothing was interrupted instead.
 */
export function restartNotice(
  report: InflightReport,
  reportPath: string,
  mode: 'auto' | 'interactive',
): string | undefined {
  const interrupted = interruptedCount(report);
  if (!isBusyStatus(report.status) || (interrupted === 0 && report.blindSpots.length === 0))
    return mode === 'auto' ? quietNotice() : undefined;
  return ferretryNotice(
    `${headline(interrupted)}\n\n` +
      `This notice is from Ferretry, not from the owner. Before re-running anything, read ${reportPath}: ` +
      'it lists what was running and what to check.',
  );
}
