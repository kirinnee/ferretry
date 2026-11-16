import { commandLabel } from '@ferretry/std';
import type { JobKeeperSource, KeptJob } from '../../../contract/job-keeping.ts';
import type { InflightReport } from './inflight-report.ts';
import { age, truncate } from './render-text.ts';
import { terminalsOf, unseenCodexTerminals } from './unkept-jobs.ts';

const COMMAND_WIDTH = 120;

/** The line the agent is given for a running job — exactly this, so it can be found and followed. */
const reattachLine = (id: string): string => `re-attach: run \`fy job attach ${id}\` as a background Bash`;

const secondsSince = (start: string, nowMs: number): number | undefined => {
  const at = Date.parse(start);
  return Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / 1000)) : undefined;
};

/** What it ended with, in the agent's words: the code, or that no exit was recorded. */
function endedWith(job: KeptJob): string {
  if (job.state === 'lost') return 'ended without an exit record (the machine or its tmux went away under it)';
  return `ended with exit code ${job.exitCode ?? '?'}`;
}

/** The agent's own background jobs this move stopped — the ones Ferretry was not keeping. */
function stoppedJobs(report: InflightReport): readonly string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  for (const entry of report.processes) {
    if (entry.unkeptJob !== true || entry.known !== undefined) continue;
    const command = truncate(commandLabel(entry.argv) ?? entry.argv, COMMAND_WIDTH);
    if (seen.has(command)) continue;
    seen.add(command);
    commands.push(`\`${command}\``);
  }
  const unseen = unseenCodexTerminals(report);
  if (unseen > 0) commands.push(`${terminalsOf(unseen)} of Codex's (Ferretry could not see the commands)`);
  return commands;
}

/**
 * The "Your jobs" section of the hand-over, or `undefined` when the ferret has no kept job to speak of: one still running,
 * or one that ended without the ferret being told. (Jobs the old session already saw end are not repeated.)
 *
 * Un-kept background jobs this move stopped ride along, each with the way to run it again — but only inside a section
 * that exists for the kept ones: the restart notice already says what was stopped.
 */
export function jobsHandover(jobs: readonly KeptJob[], report: InflightReport, nowMs: number): string | undefined {
  const running = jobs.filter(job => job.state === 'running');
  const finished = jobs.filter(job => job.state !== 'running' && job.unreported);
  if (running.length === 0 && finished.length === 0) return undefined;
  const lines = ['Your jobs'];
  // EACH SUBSECTION SAYS ONLY WHAT IS TRUE OF IT: "kept" for the running ones, "finished" for the ended ones, and "nothing was
  // stopped" only when the stopped list below is empty.
  if (running.length > 0) {
    lines.push('', 'Ferretry kept these background jobs running through the move:');
    for (const job of running)
      lines.push(
        `- \`${job.name}\` (id ${job.id}, running ${age(secondsSince(job.startedAt, nowMs))}): ${reattachLine(job.id)}`,
      );
  }
  if (finished.length > 0) {
    lines.push('', 'These background jobs finished since you last saw them:');
    for (const job of finished)
      lines.push(`- \`${job.name}\` (id ${job.id}) ${endedWith(job)}; \`fy job logs ${job.id}\``);
  }
  const stopped = stoppedJobs(report);
  if (stopped.length === 0) lines.push('', 'Nothing was stopped by the move.');
  else {
    lines.push('', 'The move stopped these background jobs, which Ferretry was not keeping:');
    for (const item of stopped) lines.push(`- ${item}: re-run it with \`fy job run …\` if you still need it`);
  }
  return lines.join('\n');
}

/** The finished jobs the hand-over just told the ferret about, so neither the next move nor the backstop repeats them. */
export const toldAbout = (jobs: readonly KeptJob[]): readonly string[] =>
  jobs.filter(job => job.state !== 'running' && job.unreported).map(job => job.id);

/** The notice and the jobs section as ONE message; either alone when the other is absent. */
export function withJobsSection(notice: string | undefined, section: string | undefined): string | undefined {
  if (section === undefined) return notice;
  return notice === undefined ? section : `${notice}\n\n${section}`;
}

// ─── the completion backstop ────────────────────────────────────────────────────────────────────────────────────

/** The one message a ferret gets when a kept job ended and no attachment was there to say so. */
export function backstopMessage(job: KeptJob): { readonly id: string; readonly text: string } {
  const how = job.state === 'lost' ? 'ended without an exit record' : `ended with ${job.exitCode ?? '?'}`;
  return { id: `job-ended-${job.id}`, text: `job ${job.name} (${job.id}) ${how}; \`fy job logs ${job.id}\`` };
}

export interface BackstopPorts {
  readonly keeper: Pick<JobKeeperSource, 'endedUnattached' | 'markReported'>;
  /**
   * The session message queue: one Ferretry-authored message, deduped by id; answers whether it was sent, `'unavailable'` when
   * no queue is bound yet (the pass then stops quietly and nothing is marked told), or `'not-held'` when that ferret cannot be
   * told right now (skipped quietly, nothing marked told, the next pass tries again).
   */
  readonly askAgent: (
    ferret: string,
    message: { readonly id: string; readonly text: string },
  ) => Promise<boolean | 'unavailable' | 'not-held'>;
  /**
   * THE FLOOD GUARD. The instant this backstop first ran (the daemon's start): a job that ended BEFORE it is history the
   * hand-over and `fy job list` already show, so it is marked told without a message. Otherwise the first pass would message
   * every job that ended before the backstop existed. Absent, nothing is treated as history.
   */
  readonly cutOverMs?: number;
  readonly log: { warn(message: string, fields?: Record<string, unknown>): void };
}

/** Ended before the backstop first ran (an end with no readable time is never history: it is told). */
const isHistory = (job: KeptJob, cutOverMs: number | undefined): boolean => {
  const endedAt = job.endedAt === undefined ? Number.NaN : Date.parse(job.endedAt);
  return cutOverMs !== undefined && Number.isFinite(endedAt) && endedAt < cutOverMs;
};

/**
 * One backstop pass: for every kept job that ended with no live attachment and nobody told, queue ONE message to the owning
 * ferret and record it as told. The dedupe id is per job, so a retry after a crash cannot send twice; the keeper already
 * leaves out any job an attachment is live on (that attachment reports the exit itself). A ferret that cannot be reached
 * is left unreported and tried again next pass. Answers how many messages were queued.
 */
export async function runJobBackstop(ports: BackstopPorts): Promise<number> {
  let queued = 0;
  for (const { ferret, job } of await ports.keeper.endedUnattached()) {
    try {
      if (isHistory(job, ports.cutOverMs)) {
        await ports.keeper.markReported(ferret, [job.id]);
        continue;
      }
      const asked = await ports.askAgent(ferret, backstopMessage(job));
      if (asked === 'unavailable') return queued;
      if (asked === 'not-held') continue;
      if (asked) queued += 1;
      await ports.keeper.markReported(ferret, [job.id]);
    } catch (error) {
      ports.log.warn('job completion message could not be queued', {
        ferret,
        job: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return queued;
}
