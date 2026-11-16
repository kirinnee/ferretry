import { type InflightReport, isBusyStatus } from './inflight-report.ts';

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
  return 'Ferretry restarted you, and nothing was interrupted. Your conversation was resumed as it was; there is nothing to re-run.';
}

const PICK_UP =
  'Your previous turn was interrupted mid-way: re-read the end of the conversation to see where it stopped, then continue from there.';

function midTurnNotice(): string {
  return `Ferretry restarted you mid-turn, and nothing you were running was lost. ${PICK_UP}`;
}

function headline(interrupted: number): string {
  if (interrupted === 0) return 'Ferretry restarted you mid-turn, and what was running could not be checked.';
  return `Ferretry restarted you mid-turn, and ${interrupted} ${interrupted === 1 ? 'command was' : 'commands were'} interrupted.`;
}

/**
 * The message sent to a restarted agent, or `undefined` when there is nothing worth saying.
 *
 * Restart and same-harness move resume the same conversation, so the agent already knows what it
 * was doing. It is told only when the session was mid-turn AND the inventory holds something not
 * known safe to lose — a blind spot counts, because "could not look" is not "nothing there". It is
 * Ferretry's own sentence — Ferretry is its subject, with no tag or footer — and the turn it rides carries
 * who it is from as metadata, so the app draws it as Ferretry's, never as the owner's words.
 *
 * A session that was mid-turn with nothing open ({@link InflightReport.midTurn}) is told its turn was interrupted and
 * to re-read where it stopped; that is the whole of what it needs, so no report is pointed at.
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
    return report.midTurn ? midTurnNotice() : mode === 'auto' ? quietNotice() : undefined;
  return `${headline(interrupted)} ${PICK_UP} Before re-running anything, read ${reportPath}: it lists what was running and what to check.`;
}
