import { commandLabel } from '@ferretry/std';
import type { InflightItem, MoveRefusal } from '../../../contract/move.ts';
import type { InflightReport } from './inflight-report.ts';
import { age, truncate } from './render-text.ts';
import {
  AGENT_COMMAND_SENTENCE,
  terminalsOf,
  UNKEPT_JOB_SENTENCE,
  UNKEPT_JOBS_SENTENCE,
  unseenCodexTerminals,
} from './unkept-jobs.ts';
import { type InflightVerdict, verdictBlocksMove } from './verdict.ts';

const DETAIL_WIDTH = 120;

/** What Ferretry tells a person when it could not list processes, without the `ps` jargon. */
function unreadableTitle(reason: string): string {
  if (reason.startsWith('the process table could not be read'))
    return 'Ferretry couldn’t list the agent’s processes on this machine (ps failed)';
  if (reason.startsWith('the session reports'))
    return 'The agent says it is working, but Ferretry can’t see what it is running';
  return 'Ferretry couldn’t check what the agent is running';
}

function processTitle(verdict: InflightVerdict): string {
  switch (verdict) {
    case 'unknown':
      return 'A program Ferretry doesn’t recognise is running';
    case 'destructive_to_interrupt':
      return 'A command that changes things is running — stopping it could leave work half-done';
    case 're_armable':
      return 'A build, test or check is running — it can simply be run again';
    case 'safe_to_kill':
      return 'A short read-only command is running';
  }
}

function toolTitle(verdict: InflightVerdict, name: string): string {
  if (verdict === 'unknown') return `The agent is in the middle of a ${name} call Ferretry can’t classify`;
  if (verdict === 'destructive_to_interrupt') return `The agent is in the middle of a ${name} call that changes things`;
  return `The agent is in the middle of a ${name} call`;
}

/** Every observation, in the order a person reads them: what blocks first, the rest after. */
function itemsOf(report: InflightReport): readonly InflightItem[] {
  const items: InflightItem[] = [];
  for (const spot of report.blindSpots)
    items.push({
      kind: 'unreadable',
      verdict: 'unknown',
      title: unreadableTitle(spot),
      detail: truncate(spot, DETAIL_WIDTH),
      blocks: true,
    });
  for (const tool of report.openTools)
    items.push({
      kind: 'tool',
      verdict: tool.verdict,
      title: toolTitle(tool.verdict, tool.name),
      detail: truncate(tool.summary, DETAIL_WIDTH),
      blocks: verdictBlocksMove(tool.verdict),
    });
  for (const entry of report.processes) {
    const attachment = entry.known?.attachment;
    if (attachment !== undefined) {
      // A kept job's attachment: safe to kill, and the move asks it to detach first. The job itself is untouched.
      items.push({
        kind: 'process',
        verdict: 'safe_to_kill',
        title: entry.known?.label ?? `attachment to job ${attachment.jobName}`,
        detail: `fy job attach ${attachment.jobId}`,
        age: age(entry.startedSecondsAgo),
        blocks: false,
      });
      continue;
    }
    if (entry.known !== undefined) continue;
    if (entry.unkeptJob === true || entry.agentCommand === true) {
      items.push({
        kind: 'process',
        verdict: entry.verdict,
        title: `${truncate(commandLabel(entry.argv) ?? entry.argv, DETAIL_WIDTH)} — ${entry.unkeptJob === true ? UNKEPT_JOB_SENTENCE : AGENT_COMMAND_SENTENCE}`,
        age: age(entry.startedSecondsAgo),
        blocks: verdictBlocksMove(entry.verdict),
        ...(entry.toolShell === undefined ? {} : { pid: entry.pid, backgroundJob: true as const }),
      });
      continue;
    }
    items.push({
      kind: 'process',
      verdict: entry.verdict,
      title: processTitle(entry.verdict),
      detail: truncate(entry.argv, DETAIL_WIDTH),
      age: age(entry.startedSecondsAgo),
      blocks: verdictBlocksMove(entry.verdict),
      // Only the agent's own background jobs carry their pid: it is what the agent is asked to stop.
      ...(entry.toolShell === undefined ? {} : { pid: entry.pid, backgroundJob: true as const }),
    });
  }
  if (report.midTurn)
    items.push({
      kind: 'turn',
      verdict: 're_armable',
      title: `The agent is mid-turn, ${report.status === 'thinking' ? 'thinking' : 'working'} — moving interrupts this turn; the new session is told to pick it up`,
      blocks: false,
    });
  if (report.codexBackgroundTerminals > 0) {
    // The footer counts terminals the tree already listed as processes: say only the ones nothing else names. The item stays
    // (and blocks) either way, because the count is what the gate refuses on.
    const unseen = unseenCodexTerminals(report);
    items.push({
      kind: 'terminal',
      verdict: 'unknown',
      title:
        unseen === 0
          ? `Codex counts ${terminalsOf(report.codexBackgroundTerminals)}, all listed above`
          : `Codex has ${terminalsOf(unseen)}${unseen === report.codexBackgroundTerminals ? '' : ' more'} Ferretry can’t see into — ${unseen === 1 ? UNKEPT_JOB_SENTENCE : UNKEPT_JOBS_SENTENCE}`,
      blocks: true,
    });
  }
  const blockers = items.filter(item => item.blocks);
  return [
    ...blockers.filter(item => item.verdict === 'destructive_to_interrupt'),
    ...blockers.filter(item => item.verdict !== 'destructive_to_interrupt'),
    ...items.filter(item => !item.blocks),
  ];
}

/** The inventory as data the PWA lists in the confirmation. */
export function describeInflight(report: InflightReport): MoveRefusal {
  const items = itemsOf(report);
  const blockers = items.filter(item => item.blocks);
  const blockedBy = blockers.some(item => item.verdict === 'destructive_to_interrupt')
    ? 'destructive'
    : blockers.every(item => item.kind === 'unreadable')
      ? 'unreadable'
      : 'unknown';
  return {
    status: report.status,
    turn: report.turn,
    blockedBy,
    items: [...items],
    restartsWithCli: report.processes.filter(
      entry => entry.known !== undefined && entry.known.kind !== 'job-attachment',
    ).length,
  };
}

/**
 * The refusal as one sentence a person can read in an alert. A blind spot keeps the daemon's own
 * reason after the plain words, because "ps failed" and "tmux would not answer" want different fixes.
 */
export function refusalSentence(report: InflightReport): string {
  const blockers = describeInflight(report).items.filter(item => item.blocks);
  const first = blockers[0];
  if (first === undefined) return 'something the agent is running could not be ruled out';
  const rest = blockers.length - 1;
  const more = rest === 0 ? '' : ` (and ${rest} more)`;
  const detail = first.detail === undefined ? '' : ` — ${first.detail}`;
  return `${first.title}${detail}${more}`;
}
