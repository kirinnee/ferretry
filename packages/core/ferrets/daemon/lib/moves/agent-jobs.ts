import { isHarnessCommand, type KnownProcess } from './harness-provenance.ts';
import type { InflightReport } from './inflight-report.ts';
import type { ProcRow } from './process-table.ts';
import { age, truncate } from './render-text.ts';
import { verdictBlocksMigration } from './verdict.ts';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish']);
/** `-c`, or a cluster that carries it: `-lc`, `-ic`. */
const COMMAND_FLAG = /^-[a-z]*c[a-z]*$/u;
const COMMAND_WIDTH = 160;

const basename = (word: string): string => word.split('/').at(-1) ?? '';

/** `zsh -c …`, `/bin/bash -lc …`: a shell handed one command line to run. */
function isCommandShell(argv: string): boolean {
  const words = argv.split(/\s+/u).filter(Boolean);
  if (!SHELLS.has(basename(words[0] ?? ''))) return false;
  const flags = words.slice(1).filter(word => word.startsWith('-'));
  return flags.some(word => COMMAND_FLAG.test(word));
}

/**
 * The processes the agent started itself, through its own tool shell: for each one, the pid of that
 * shell.
 *
 * A harness runs every shell command it is asked for — a Claude `Bash` call, a codex `exec` — as a
 * `<shell> -c …` child of the CLI, and a job left running in the background is that shell, or what it
 * started, outliving the call. That is all this recognises: a command shell whose parent is the pane's
 * own process (the CLI, where it was launched directly) or a process {@link identifyKnownProcesses}
 * named the harness, together with everything below it.
 *
 * A shell that leads to a harness CLI is not one of these: there it is the wrapper the pane launched
 * the agent THROUGH, and asking the agent to stop it would be asking it to stop itself.
 *
 * `rows` must list parents before children, which {@link descendantsOf} guarantees.
 */
export function identifyAgentJobs(
  rows: readonly ProcRow[],
  rootPid: number,
  known: ReadonlyMap<number, KnownProcess>,
): ReadonlyMap<number, number> {
  const shellOf = new Map<number, number>();
  const leadsToHarness = new Set<number>();
  for (const row of rows) {
    const inherited = shellOf.get(row.ppid);
    if (inherited !== undefined) {
      shellOf.set(row.pid, inherited);
      if (isHarnessCommand(row.argv)) leadsToHarness.add(inherited);
      continue;
    }
    const harnessChild = row.ppid === rootPid || known.get(row.ppid)?.kind === 'harness';
    if (harnessChild && !known.has(row.pid) && isCommandShell(row.argv)) shellOf.set(row.pid, row.pid);
  }
  for (const [pid, shell] of shellOf) if (leadsToHarness.has(shell)) shellOf.delete(pid);
  return shellOf;
}

/** One background job that keeps a migration from going ahead, as the agent is told about it. */
export interface AgentJob {
  readonly pid: number;
  readonly command: string;
  readonly age?: string;
}

/**
 * The agent's own jobs that BLOCK this migration — what it is asked to stop. Empty when nothing it
 * started is in the way, which is also the answer when something else blocks: the ask is only offered
 * where stopping these is the whole remedy.
 */
export function blockingAgentJobs(report: InflightReport): readonly AgentJob[] {
  return report.processes
    .filter(entry => entry.toolShell !== undefined && verdictBlocksMigration(entry.verdict))
    .map(entry => ({
      pid: entry.pid,
      command: truncate(entry.argv, COMMAND_WIDTH),
      ...(entry.startedSecondsAgo === undefined ? {} : { age: age(entry.startedSecondsAgo) }),
    }));
}

/**
 * The words the agent gets. Who sent it is the queue entry's `by`, never text here; the pids are named
 * so the agent can find them whichever way it started them.
 */
export function agentJobsMessage(jobs: readonly AgentJob[]): string {
  const lines = jobs.map(
    job => `- pid ${job.pid}${job.age === undefined ? '' : ` (running ${job.age})`}: ${job.command}`,
  );
  const one = jobs.length === 1;
  return [
    'Ferretry could not move this session to another account or model: its safety check refused because ' +
      `${one ? 'this job you started is' : 'these jobs you started are'} still running in the background:`,
    '',
    ...lines,
    '',
    `The owner asked Ferretry to ask you to stop ${one ? 'it' : 'them'}. Stop each one that is safe to stop — ` +
      'with the tool you started it from, or by killing its pid. If one has to keep running, say why instead. ' +
      'One that has already finished needs nothing. The owner will run the safety check again after that.',
  ].join('\n');
}

/**
 * The queue id for asking about exactly these jobs, so pressing the button twice asks once while a
 * different set of jobs is a new question.
 */
export function agentJobsMessageId(jobs: readonly AgentJob[]): string {
  const pids = [...new Set(jobs.map(job => job.pid))].sort((left, right) => left - right).join('-');
  // A queue id is at most 128 characters; a long list is named by a digest of the same words instead.
  return pids.length <= MAX_LISTED_ID ? `migrate-jobs-${pids}` : `migrate-jobs-h${fnv1a(pids)}`;
}

const MAX_LISTED_ID = 100;

/** FNV-1a, 32-bit, as hex: a stable name for a list, not a secret. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
