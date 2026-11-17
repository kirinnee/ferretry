import type { InflightReport } from './inflight-report.ts';

/** What is true of a background job Ferretry is not keeping, and what to do about it next time. */
export const UNKEPT_JOB_SENTENCE =
  'a background job Ferretry is not keeping; it stops when the ferret moves. Start long jobs with `fy job run` so they survive.';
/** The same, for several at once. */
export const UNKEPT_JOBS_SENTENCE =
  'background jobs Ferretry is not keeping; they stop when the ferret moves. Start long jobs with `fy job run` so they survive.';
/**
 * The neutral wording for a Claude tool shell that may be a foreground call: Claude writes every Bash call's stdout to
 * `tasks/<id>.output`, so that path alone never makes it a background job.
 */
export const AGENT_COMMAND_SENTENCE = 'a command the agent is running; it stops when the ferret moves.';

/** The Codex app-server children the tree shows: each is a background terminal whose command Ferretry can read. */
const visibleCodexJobs = (report: InflightReport): number =>
  report.processes.filter(entry => entry.unkeptJob === true && entry.toolShell === undefined).length;

/**
 * The footer's background-terminal count, less the ones already listed as processes: the same job must not be counted
 * twice. What is left are terminals Ferretry cannot see into.
 */
export const unseenCodexTerminals = (report: InflightReport): number =>
  Math.max(0, report.codexBackgroundTerminals - visibleCodexJobs(report));

/** "1 background terminal" / "3 background terminals". */
export const terminalsOf = (count: number): string => `${count} background terminal${count === 1 ? '' : 's'}`;
