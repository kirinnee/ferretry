/**
 * Jobs' pure rules (docs/jobs.md): naming, caps, retention, how a job's state and exit code are read, the command line
 * a person typed, and the wrapper script the pane runs. No clock, no files, no tmux: every fact is handed in.
 */
import {
  JOB_MAX_RUNNING_GLOBAL,
  JOB_MAX_RUNNING_PER_FERRET,
  JOB_NAME_PATTERN,
  JOB_RETENTION_DAYS,
  JOB_RETENTION_FINISHED_PER_FERRET,
  type JobExit,
  type JobState,
} from '../../../contract/index.ts';

export const JOB_TMUX_PREFIX = 'fy-job-';
/** The tmux option that marks a session as a job and names its ferret; terminal sweeps never read it. */
export const JOB_OWNER_OPTION = '@fy_job_owner';
export const JOB_ID_OPTION = '@fy_job_id';

// ─── names ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The tmux session of a job: the prefix, the owner (shortened, path-safe) and the id. */
export function jobTmuxSessionName(owner: string, id: string): string {
  const stem = owner.replaceAll(/[^A-Za-z0-9_-]/gu, '-').slice(0, 28) || 'session';
  return `${JOB_TMUX_PREFIX}${stem}-${id}`.slice(0, 80);
}

/**
 * A name for a job nobody named: its command's first word (a path loses its folders, `.sh` its extension), cleaned to the
 * name grammar, then made unique among the ferret's jobs with `-2`, `-3`, … .
 */
export function defaultJobName(command: string, taken: ReadonlySet<string>): string {
  const first = command.trim().split(/\s+/u)[0] ?? '';
  const base =
    first
      .split('/')
      .at(-1)
      ?.replace(/\.[A-Za-z0-9]{1,4}$/u, '')
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '')
      .slice(0, 24) ?? '';
  const stem = /^[a-z]/u.test(base) ? base : `job${base === '' ? '' : `-${base}`}`.slice(0, 24);
  const candidate = (n: number): string => (n === 1 ? stem : `${stem}-${n}`);
  for (let n = 1; ; n += 1) {
    const name = candidate(n);
    if (!taken.has(name) && JOB_NAME_PATTERN.test(name) && !/^[a-f0-9]{12}$/u.test(name)) return name;
  }
}

/** Finds a job by id or name among `jobs`. An exact id wins over a name. */
export function findJob<T extends { readonly id: string; readonly name: string }>(
  jobs: readonly T[],
  key: string,
): T | undefined {
  return jobs.find(job => job.id === key) ?? jobs.find(job => job.name === key);
}

// ─── caps ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why one more job may NOT start, or nothing when it may. Jobs are their own tmux sessions, so they do not take terminal slots;
 * they have a cap of their own per ferret and across the machine. A refusal says which one and what to do.
 */
export function jobCapacityRefusal(running: { readonly ferret: number; readonly global: number }): string | undefined {
  if (running.ferret >= JOB_MAX_RUNNING_PER_FERRET)
    return `this ferret already has ${running.ferret} running jobs (the limit is ${JOB_MAX_RUNNING_PER_FERRET}); wait for one or stop one with fy job stop`;
  if (running.global >= JOB_MAX_RUNNING_GLOBAL)
    return `the machine already has ${running.global} running jobs (the limit is ${JOB_MAX_RUNNING_GLOBAL}); try again when some end`;
  return undefined;
}

// ─── retention ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FinishedJob {
  readonly id: string;
  /** When it ended, in epoch ms; a lost job counts from when it started. */
  readonly endedAtMs: number;
}

/**
 * Which finished jobs of ONE ferret to delete: any older than the retention window, and anything beyond the newest N.
 * A running job is never passed in, so never chosen.
 */
export function jobsToDelete(
  finished: readonly FinishedJob[],
  nowMs: number,
  retention: { readonly days: number; readonly perFerret: number } = {
    days: JOB_RETENTION_DAYS,
    perFerret: JOB_RETENTION_FINISHED_PER_FERRET,
  },
): readonly string[] {
  const cutoff = nowMs - retention.days * 86_400_000;
  const newestFirst = finished.toSorted((a, b) => b.endedAtMs - a.endedAtMs);
  return newestFirst.filter((job, index) => job.endedAtMs < cutoff || index >= retention.perFerret).map(job => job.id);
}

// ─── state and exit ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An exit record beats everything (the wrapper wrote it, whatever became of tmux); otherwise a living tmux session is
 * `running`; neither is `lost` — the host rebooted or the tmux server was killed under it.
 */
export function jobState(exit: JobExit | undefined, sessionAlive: boolean): JobState {
  if (exit !== undefined) return 'exited';
  return sessionAlive ? 'running' : 'lost';
}

/** `fy job attach`'s own exit status for a job that ended: its code (a signal death is already 128 + n). */
export function attachExitCode(state: JobState, exit: JobExit | undefined, lostCode: number): number {
  if (state === 'exited' && exit !== undefined) return Math.min(255, exit.code);
  return lostCode;
}

// ─── the wrapper the pane runs ────────────────────────────────────────────────────────────────────────────────────

/** How long the job's tree gets after SIGTERM before SIGKILL, in seconds (the wrapper's own timer). */
export const JOB_STOP_GRACE_SECONDS = 5;

/**
 * The POSIX `sh` program the pane runs: `sh -c <this> fy-job <dir> <shell> <command>`.
 *
 * - runs `<shell> -l -c <command>` (the same login shell terminals use) with stdin closed and stdout+stderr APPENDED to
 *   `<dir>/output.log`;
 * - on SIGINT/SIGTERM/SIGHUP (the pane closing, a stop) it signals the job's whole process TREE, found by walking children with
 *   `pgrep -P` (TERM to every one, then KILL to those same pids after the grace), and still waits for the job, so the exit
 *   is recorded either way. A tree walk rather than a process group: job control needs a terminal and its pgid arithmetic
 *   differed between shells; a process that detaches itself (setsid, a double fork) before the stop is out of reach;
 * - a watcher in the wrapper turns the daemon's `<dir>/stop` file into SIGTERM on the wrapper itself (within a second). A stop is
 *   a FILE, never a signal typed into the pane: a tty interrupt reaches the job directly as SIGINT and races the wrapper, and
 *   the file works however early or late it is written;
 * - writes `<dir>/exit.json` ATOMICALLY (a temp file, then `mv`) when the job ends — the wrapper does this, not the daemon,
 *   so an exit is recorded even while the daemon is down. A code of 129–192 is also named as a signal (`TERM`).
 *
 * It must not end in `;` (tmux would read that as a command separator).
 */
export const JOB_WRAPPER_SCRIPT = `dir=$1
shell=$2
cmd=$3
log="$dir/output.log"
pid=
gpid=
stopping=
tree() {
  for child in $(pgrep -P "$1" 2>/dev/null); do tree "$child"; done
  echo "$1"
}
term() {
  stopping=1
  [ -n "$pid" ] || return 0
  all=$(tree "$pid")
  for one in $all; do kill -s TERM "$one" 2>/dev/null; done
  if [ -z "$gpid" ]; then
    ( sleep ${JOB_STOP_GRACE_SECONDS}; for one in $all; do kill -s KILL "$one" 2>/dev/null; done ) >/dev/null 2>&1 &
    gpid=$!
  fi
}
trap term INT TERM HUP
"$shell" -l -c "$cmd" >>"$log" 2>&1 </dev/null &
pid=$!
( while [ ! -e "$dir/stop" ]; do sleep 1; done; kill -TERM $$ ) >/dev/null 2>&1 &
watcher=$!
[ -z "$stopping" ] || term
wait "$pid"
code=$?
while kill -0 "$pid" 2>/dev/null; do
  wait "$pid"
  code=$?
done
kill "$watcher" 2>/dev/null
[ -z "$gpid" ] || kill "$gpid" 2>/dev/null
signal=
if [ "$code" -gt 128 ] && [ "$code" -le 192 ]; then
  name=$(kill -l $((code - 128)) 2>/dev/null)
  case "$name" in
    ''|*[!A-Z0-9]*) ;;
    *) signal=$name ;;
  esac
fi
ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -n "$signal" ]; then
  printf '{"code":%d,"signal":"%s","endedAt":"%s"}\\n' "$code" "$signal" "$ended" >"$dir/exit.json.tmp"
else
  printf '{"code":%d,"endedAt":"%s"}\\n' "$code" "$ended" >"$dir/exit.json.tmp"
fi
mv "$dir/exit.json.tmp" "$dir/exit.json"
exit 0
`;

/** The argv a pane runs for a job: the wrapper, then the job's folder, the login shell and the command. */
export function jobPaneArgv(input: {
  readonly dir: string;
  readonly shell: string;
  readonly command: string;
}): readonly string[] {
  return ['/bin/sh', '-c', JOB_WRAPPER_SCRIPT, 'fy-job', input.dir, input.shell, input.command];
}
