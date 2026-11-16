import { commandLabel } from '@ferretry/std';
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

/**
 * Everything the agent itself had running that the restart stopped — read-only commands included, because "safe to
 * kill" means the MOVE may go ahead, not that the agent does not want the answer: a `fy wait <child>` or an `rg …` the
 * agent was blocked on is gone, and so is the output it was going to read. The harness's own helpers are not the
 * agent's. A tool call and the process it started are one command and appear once.
 */
function stoppedCommands(report: InflightReport): readonly string[] {
  const seen = new Set<string>();
  const stopped: string[] = [];
  const add = (text: string) => {
    const label = text.replace(/\s+/gu, ' ').trim();
    if (label === '' || seen.has(label)) return;
    seen.add(label);
    stopped.push(label);
  };
  for (const entry of report.processes) if (entry.known === undefined) add(commandLabel(entry.argv) ?? entry.argv);
  for (const tool of report.openTools) add(tool.summary);
  return stopped;
}

const LABEL_LIMIT = 60;
const NAMED_LIMIT = 3;

function shortened(label: string): string {
  return label.length <= LABEL_LIMIT ? label : `${label.slice(0, LABEL_LIMIT - 1)}…`;
}

/** The `fy wait <id>` calls among what was stopped, whose ids the agent must wait on again. */
function waitedOn(stopped: readonly string[]): readonly string[] {
  const ids: string[] = [];
  for (const label of stopped) {
    const id = /(?:^|\/|\s)fy(?:\s+--as-owner)?\s+wait\s+(\S+)/u.exec(label)?.[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
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

/** What was stopped, in words: `2 read-only commands were stopped (fy wait mwxx…, rg foo); re-run …`. */
function stoppedSentence(stopped: readonly string[]): string {
  const named = stopped.slice(0, NAMED_LIMIT).map(shortened);
  const more = stopped.length - named.length;
  const list = `${named.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
  const waits = waitedOn(stopped);
  const again =
    waits.length === 0
      ? ''
      : ` Wait again for ${waits.map(id => `\`${id}\``).join(', ')} (\`fy wait ${waits[0]}\`): it was not answered.`;
  return `${stopped.length} ${stopped.length === 1 ? 'command was' : 'commands were'} stopped (${list}); re-run ${stopped.length === 1 ? 'it' : 'them'} if you still need the output.${again}`;
}

/**
 * The message sent to a restarted agent, or `undefined` when there is nothing worth saying.
 *
 * Restart and same-harness move resume the same conversation, so the agent already knows what it
 * was doing. It is told only when the session was mid-turn AND the inventory holds something not
 * known safe to lose — a blind spot counts, because "could not look" is not "nothing there" — OR something
 * the agent had started was stopped, SAFE ONES INCLUDED: a read-only `fy wait <child>` the agent was blocked on is
 * lost output, and telling it "nothing was interrupted" would leave it never waiting again. It is
 * Ferretry's own sentence — Ferretry is its subject, with no tag or footer — and the turn it rides carries
 * who it is from as metadata, so the app draws it as Ferretry's, never as the owner's words.
 *
 * A session that was mid-turn with nothing open ({@link InflightReport.midTurn}) is told its turn was interrupted and
 * to re-read where it stopped; that is the whole of what it needs, so no report is pointed at.
 *
 * AN AUTO SESSION IS THE ONE EXCEPTION to "send nothing": a resume with no message makes the resume
 * domain type its default "continue the assigned task" prompt, which would restart work an idle
 * session had finished. It is sent a one-line notice that nothing was interrupted instead — never when
 * the session was busy and something it ran was stopped.
 */
export function restartNotice(
  report: InflightReport,
  reportPath: string,
  mode: 'auto' | 'interactive',
): string | undefined {
  const interrupted = interruptedCount(report);
  const stopped = isBusyStatus(report.status) ? stoppedCommands(report) : [];
  if (!isBusyStatus(report.status) || (interrupted === 0 && report.blindSpots.length === 0 && stopped.length === 0))
    return report.midTurn ? midTurnNotice() : mode === 'auto' ? quietNotice() : undefined;
  const opening =
    interrupted === 0 && report.blindSpots.length === 0 ? 'Ferretry restarted you mid-turn.' : headline(interrupted);
  const what = stopped.length === 0 ? '' : ` ${stoppedSentence(stopped)}`;
  return `${opening}${what} ${PICK_UP} Before re-running anything, read ${reportPath}: it lists what was running and what to check.`;
}
