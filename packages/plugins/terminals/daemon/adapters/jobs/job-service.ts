/**
 * The job keeper's lifecycle (docs/jobs.md). It owns no process: the wrapper in a tmux pane runs the command and records its
 * exit, and everything this service reports is DERIVED from those files and the tmux listing — so a fresh instance (a daemon
 * restart) reads exactly what the old one did.
 */
import { instantFromEpochMs, isJobAttachCommand } from '@ferretry/std';
import {
  JOB_MAX_COMMAND_LENGTH,
  JOB_MAX_RUNNING_GLOBAL,
  JOB_MAX_RUNNING_PER_FERRET,
  JOB_OUTPUT_CHUNK_BYTES,
  JOB_RETENTION_DAYS,
  JOB_RETENTION_FINISHED_PER_FERRET,
  type JobAttachmentListView,
  type JobAttachmentView,
  type JobExit,
  type JobListView,
  type JobMeta,
  type JobOutputView,
  type JobStartedBy,
  type JobView,
} from '../../../contract/index.ts';
import type { KeptJob } from '@ferretry/core-ferrets/contract';
import type { TerminalClock, TerminalIdSource, TerminalSessionResolver } from '../../lib/terminal/contracts.ts';
import {
  type AttachmentEntry,
  entriesOf,
  withDetaching,
  withCutOver,
  withEntry,
  withoutEntry,
  withOrphansDetaching,
  withoutStale,
} from '../../lib/jobs/attachments.ts';
import type {
  AttachmentStore,
  JobFilesPort,
  JobRuntimePort,
  ProcessProof,
  RunningJob,
  TrackedProcess,
} from '../../lib/jobs/contracts.ts';
import {
  jobCapacityRefusal,
  defaultJobName,
  findJob,
  JOB_STOP_GRACE_SECONDS,
  jobsToDelete,
  jobState,
} from '../../lib/jobs/policy.ts';

export class JobServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'capacity' | 'bad_request' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'JobServiceError';
  }
}

export interface JobServiceOptions {
  /** Whether a folder exists (a job starts where the caller was; tmux would silently start elsewhere otherwise). */
  readonly isDirectory: (path: string) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  /** The CLI's binary name (`fy`), single-sourced by the composition root: what an attachment's command line must run. */
  readonly binaryName: string;
  /** Told when a job started or was stopped (the daemon log line). */
  readonly onEvent?: (event: {
    readonly kind: 'started' | 'stopped' | 'removed';
    readonly sessionId: string;
    readonly jobId: string;
  }) => void;
}

interface Row {
  readonly owner: string;
  readonly meta: JobMeta;
  readonly exit: JobExit | undefined;
  readonly running: RunningJob | undefined;
}

/** How long `stop` waits for the wrapper's own TERM → KILL before it takes the pane down itself. */
const STOP_WAIT_MS = (JOB_STOP_GRACE_SECONDS + 4) * 1_000;
const STOP_POLL_MS = 200;
/** How long, after the service's own SIGKILL, the tracked processes get to disappear before one is called a survivor. */
const KILL_SETTLE_MS = 2_000;

export class JobService {
  private turn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly files: JobFilesPort,
    private readonly runtime: JobRuntimePort,
    private readonly attachments: AttachmentStore,
    private readonly proof: ProcessProof,
    private readonly sessions: TerminalSessionResolver,
    private readonly clock: TerminalClock,
    private readonly ids: TerminalIdSource,
    private readonly options: JobServiceOptions,
  ) {}

  // ─── reading ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async session(reference: string) {
    const session = await this.sessions.resolve(reference);
    if (!session?.cwd.startsWith('/')) throw new JobServiceError('not_found', 'job session not found');
    return session;
  }

  /** Every job on disk with its exit and its live tmux session, if any. A folder without usable metadata is skipped. */
  private async rows(owner?: string): Promise<readonly Row[]> {
    const [folders, running] = await Promise.all([this.files.list(), this.runtime.list()]);
    const alive = new Map(running.map(job => [`${job.owner}\n${job.id}`, job]));
    const rows: Row[] = [];
    for (const folder of folders) {
      if (owner !== undefined && folder.owner !== owner) continue;
      const meta = await this.files.readMeta(folder.owner, folder.id);
      if (meta === undefined) continue;
      rows.push({
        owner: folder.owner,
        meta,
        exit: await this.files.readExit(folder.owner, folder.id),
        running: alive.get(`${folder.owner}\n${folder.id}`),
      });
    }
    return rows;
  }

  private async view(owner: string, row: Row, attachments: readonly AttachmentEntry[]): Promise<JobView> {
    const state = jobState(row.exit, row.running !== undefined);
    return {
      id: row.meta.id,
      sessionId: owner,
      name: row.meta.name,
      command: row.meta.command,
      cwd: row.meta.cwd,
      state,
      startedAt: row.meta.startedAt,
      startedBy: row.meta.startedBy,
      ...(row.exit === undefined ? {} : { exitCode: row.exit.code, endedAt: row.exit.endedAt }),
      ...(row.exit?.signal === undefined ? {} : { signal: row.exit.signal }),
      outputBytes: await this.files.outputSize(owner, row.meta.id),
      attachments: attachments.filter(entry => entry.jobId === row.meta.id).length,
    };
  }

  private async liveAttachments(sessionId: string): Promise<readonly AttachmentEntry[]> {
    return entriesOf(await this.prune(), sessionId);
  }

  async list(reference: string): Promise<JobListView> {
    const session = await this.session(reference);
    const [rows, all, attachments] = await Promise.all([
      this.rows(session.id),
      this.runtime.list(),
      this.liveAttachments(session.id),
    ]);
    const views = await Promise.all(rows.map(async row => await this.view(session.id, row, attachments)));
    return {
      sessionId: session.id,
      jobs: views.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt)),
      limits: {
        runningPerFerret: JOB_MAX_RUNNING_PER_FERRET,
        runningGlobal: JOB_MAX_RUNNING_GLOBAL,
        running: all.filter(job => job.owner === session.id).length,
        retentionDays: JOB_RETENTION_DAYS,
        retainedFinishedPerFerret: JOB_RETENTION_FINISHED_PER_FERRET,
      },
    };
  }

  /** One job by id or name. A name that several retained jobs share reads the running one, else the newest. */
  private async row(sessionId: string, key: string): Promise<Row> {
    const rows = (await this.rows(sessionId)).toSorted((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt));
    const ordered = [
      ...rows.filter(row => row.running !== undefined),
      ...rows.filter(row => row.running === undefined),
    ];
    const found = findJob(
      ordered.map(row => ({ id: row.meta.id, name: row.meta.name, row })),
      key,
    );
    if (found === undefined) throw new JobServiceError('not_found', `no job ${key}`);
    return found.row;
  }

  async get(reference: string, key: string): Promise<JobView> {
    const session = await this.session(reference);
    return await this.view(session.id, await this.row(session.id, key), await this.liveAttachments(session.id));
  }

  /**
   * The log from byte `from`, or its last `tail` lines. Whole lines only while the job runs (a line is not cut in two between
   * polls); once it ended the rest is flushed. `detach` is true when the daemon asked THIS attachment to let go.
   */
  async output(
    reference: string,
    key: string,
    request: { readonly from?: number; readonly tail?: number; readonly attachment?: string },
  ): Promise<JobOutputView> {
    const session = await this.session(reference);
    const row = await this.row(session.id, key);
    const size = await this.files.outputSize(session.id, row.meta.id);
    const state = jobState(row.exit, row.running !== undefined);
    const finished = state !== 'running';
    let from = Math.min(Math.max(0, request.from ?? 0), size);
    if (request.from === undefined && request.tail !== undefined)
      from = await this.tailStart(session.id, row.meta.id, size, request.tail, finished);
    const bytes = await this.files.readOutput(
      session.id,
      row.meta.id,
      from,
      Math.min(JOB_OUTPUT_CHUNK_BYTES, size - from),
    );
    let end = bytes.byteLength;
    if (!(finished && from + end >= size)) {
      // Not the log's end, or the job still runs: stop after the last newline so a line is never split between polls.
      const lastNewline = bytes.lastIndexOf(0x0a);
      end = lastNewline === -1 ? (bytes.byteLength >= JOB_OUTPUT_CHUNK_BYTES ? bytes.byteLength : 0) : lastNewline + 1;
    }
    const next = from + end;
    const attachments = await this.liveAttachments(session.id);
    const mine =
      request.attachment === undefined ? undefined : attachments.find(entry => entry.id === request.attachment);
    const ended = finished && next >= size;
    // A live attachment was just served the end of the log: it prints the exit, so the ferret has been told.
    if (ended && mine !== undefined && !mine.detaching)
      await this.files.markReported(session.id, row.meta.id).catch(() => undefined);
    return {
      text: new TextDecoder().decode(bytes.subarray(0, end)),
      next,
      size,
      job: await this.view(session.id, row, attachments),
      ended,
      detach: mine?.detaching === true,
    };
  }

  /**
   * The byte offset where the last `lines` lines of the log begin. While the job runs only COMPLETE lines count (a half-written
   * last line is not shown yet); once it ended, an unterminated last line is a line too.
   */
  private async tailStart(owner: string, id: string, size: number, lines: number, finished: boolean): Promise<number> {
    if (lines <= 0 || size === 0) return size;
    const window = Math.min(size, 1024 * 1024);
    const from = size - window;
    const bytes = await this.files.readOutput(owner, id, from, window);
    const lastNewline = bytes.lastIndexOf(0x0a);
    // Where the last counted line ends (exclusive): the last newline, or the very end of a finished log's unterminated line.
    const end = finished && lastNewline !== bytes.byteLength - 1 ? bytes.byteLength : lastNewline + 1;
    if (end <= 0) return finished ? from : size;
    let seen = 0;
    for (let index = end - 2; index >= 0; index -= 1) {
      if (bytes[index] === 0x0a) {
        seen += 1;
        if (seen === lines) return from + index + 1;
      }
    }
    return from;
  }

  // ─── starting and stopping ──────────────────────────────────────────────────────────────────────────────────────

  async start(
    reference: string,
    input: { readonly command: string; readonly cwd?: string; readonly name?: string },
    startedBy: JobStartedBy,
  ): Promise<JobView> {
    const turn = this.turn.then(async () => await this.startNow(reference, input, startedBy));
    this.turn = turn.catch(() => undefined);
    return await turn;
  }

  private async startNow(
    reference: string,
    input: { readonly command: string; readonly cwd?: string; readonly name?: string },
    startedBy: JobStartedBy,
  ): Promise<JobView> {
    const session = await this.session(reference);
    const command = input.command;
    if (command.trim() === '' || command.length > JOB_MAX_COMMAND_LENGTH || command.includes('\0'))
      throw new JobServiceError('bad_request', 'a job needs a command (at most 16384 characters, no NUL byte)');
    const cwd = input.cwd ?? session.cwd;
    if (!(await this.options.isDirectory(cwd)))
      throw new JobServiceError('bad_request', `there is no folder ${cwd} to run a job in`);
    const [rows, running] = await Promise.all([this.rows(session.id), this.runtime.list()]);
    const full = jobCapacityRefusal({
      ferret: running.filter(job => job.owner === session.id).length,
      global: running.length,
    });
    if (full !== undefined) throw new JobServiceError('capacity', full);
    const runningNames = new Set(rows.filter(row => row.running !== undefined).map(row => row.meta.name));
    if (input.name !== undefined && runningNames.has(input.name))
      throw new JobServiceError('conflict', `this ferret already has a running job named ${input.name}`);
    const name = input.name ?? defaultJobName(command, new Set(rows.map(row => row.meta.name)));
    const id = this.ids.next();
    const meta: JobMeta = {
      id,
      name,
      command,
      cwd,
      startedAt: instantFromEpochMs(this.clock.now()),
      startedBy,
    };
    const dir = await this.files.create(session.id, id);
    try {
      await this.files.writeMeta(session.id, id, meta);
      await this.runtime.start({ owner: session.id, id, dir, cwd, command, limited: startedBy.by === 'agent' });
    } catch (error) {
      await this.files.remove(session.id, id).catch(() => undefined);
      throw error;
    }
    this.options.onEvent?.({ kind: 'started', sessionId: session.id, jobId: id });
    await this.sweep().catch(() => undefined);
    return await this.get(session.id, id);
  }

  /**
   * Stops a job's tree: the wrapper turns the stop request into SIGTERM, then SIGKILL after the grace (its KILL clock starts at the
   * TERM, so it lands well inside `STOP_WAIT_MS`). If the wrapper still has not recorded the exit by then, this service KILLs every
   * process the wrapper tracked (the same pid + start, never a reused pid) BEFORE it takes the pane down, and records the exit only
   * once none of them is alive. A process that survives even SIGKILL is said plainly, as an error, and the job stays running: an
   * exit is never recorded over a live descendant. A job already ended is answered as it is.
   */
  async stop(reference: string, key: string): Promise<JobView> {
    const session = await this.session(reference);
    const row = await this.row(session.id, key);
    if (row.exit !== undefined || row.running === undefined) return await this.get(session.id, row.meta.id);
    await this.files.requestStop(session.id, row.meta.id);
    for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
      await this.options.sleep(STOP_POLL_MS);
      if ((await this.files.readExit(session.id, row.meta.id)) !== undefined) break;
    }
    if ((await this.files.readExit(session.id, row.meta.id)) === undefined) {
      const survivors = await this.killTracked(session.id, row.meta.id);
      if (survivors.length > 0)
        throw new JobServiceError(
          'conflict',
          `could not stop job ${row.meta.name}: ${survivors.map(one => one.pid).join(', ')} still running after SIGKILL; the job stays running until ${survivors.length === 1 ? 'it is' : 'they are'} gone`,
        );
      await this.runtime.kill(row.running);
      if ((await this.files.readExit(session.id, row.meta.id)) === undefined)
        await this.files.writeExit(session.id, row.meta.id, {
          code: 137,
          signal: 'KILL',
          endedAt: instantFromEpochMs(this.clock.now()),
        });
    }
    this.options.onEvent?.({ kind: 'stopped', sessionId: session.id, jobId: row.meta.id });
    return await this.get(session.id, row.meta.id);
  }

  /**
   * SIGKILL to every tracked process that is still the SAME process (pid + start), then up to `KILL_SETTLE_MS` for them to go.
   * Answers those still alive. A start reading this host cannot compare (not the Linux tick count) counts as alive and is never
   * signalled: a pid is only signalled once proved to be the process the wrapper saw.
   */
  private async killTracked(owner: string, id: string): Promise<readonly TrackedProcess[]> {
    const tracked = await this.files.readTracked(owner, id);
    const numeric = (start: string): boolean => /^\d+$/u.test(start);
    /** Whether the tracked process may still run: gone and a reused pid are not; one this host cannot compare is. */
    const status = async (one: TrackedProcess): Promise<'gone' | 'same' | 'unprovable'> => {
      const now = await this.proof.startOf(one.pid).catch(() => 'unknown' as const);
      if (now === undefined) return 'gone';
      if (now === 'unknown' || !numeric(one.start)) return 'unprovable';
      return now === one.start ? 'same' : 'gone';
    };
    const alive = async (): Promise<readonly TrackedProcess[]> => {
      const still: TrackedProcess[] = [];
      for (const one of tracked) if ((await status(one)) !== 'gone') still.push(one);
      return still;
    };
    for (const one of tracked)
      if ((await status(one)) === 'same') await this.proof.kill(one.pid).catch(() => undefined);
    let left = await alive();
    for (let waited = 0; left.length > 0 && waited < KILL_SETTLE_MS; waited += STOP_POLL_MS) {
      await this.options.sleep(STOP_POLL_MS);
      left = await alive();
    }
    return left;
  }

  // ─── retention ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** Deletes finished jobs past the retention window or beyond the newest N per ferret. Running jobs are never touched. */
  async sweep(): Promise<number> {
    const rows = await this.rows();
    const byOwner = new Map<string, Row[]>();
    // A job whose tmux session is alive and has no exit record is running: never a candidate.
    for (const row of rows.filter(row => row.running === undefined || row.exit !== undefined))
      byOwner.set(row.owner, [...(byOwner.get(row.owner) ?? []), row]);
    const now = this.clock.now();
    let removed = 0;
    for (const [owner, group] of byOwner) {
      const doomed = jobsToDelete(
        group.map(row => ({ id: row.meta.id, endedAtMs: Date.parse(row.exit?.endedAt ?? row.meta.startedAt) })),
        now,
      );
      for (const id of doomed) {
        await this.files.remove(owner, id).catch(() => undefined);
        this.options.onEvent?.({ kind: 'removed', sessionId: owner, jobId: id });
        removed += 1;
      }
    }
    return removed;
  }

  // ─── attachments ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Drops the entries whose process is not the one that registered, and answers what is left. */
  private async prune() {
    const current = await this.attachments.read();
    if (current.entries.length === 0) return current;
    const starts = new Map<number, string | undefined | 'unknown'>();
    for (const entry of current.entries)
      starts.set(entry.pid, await this.proof.startOf(entry.pid).catch(() => 'unknown' as const));
    const pruned = withoutStale(current, starts);
    if (pruned.entries.length === current.entries.length) return current;
    return await this.attachments.update(state => withoutStale(state, starts));
  }

  async registerAttachment(
    reference: string,
    input: { readonly jobId: string; readonly pid: number; readonly claudeTaskId?: string },
  ): Promise<JobAttachmentView> {
    const session = await this.session(reference);
    const job = await this.row(session.id, input.jobId);
    const start = await this.proof.startOf(input.pid).catch(() => 'unknown' as const);
    const harness = await this.proof.harnessOf?.(input.pid).catch(() => undefined);
    if (start === undefined) throw new JobServiceError('bad_request', `pid ${input.pid} is not a running process`);
    // ARGV IS NECESSARY, NEVER SUFFICIENT: the gate trusts this registry, so only an `fy job attach|run` process gets in. An
    // argv that cannot be read refuses too (fail closed).
    const argv = await this.proof.argvOf(input.pid).catch(() => 'unknown' as const);
    if (argv === undefined) throw new JobServiceError('bad_request', `pid ${input.pid} is not a running process`);
    if (argv === 'unknown' || !isJobAttachCommand(argv, this.options.binaryName))
      throw new JobServiceError(
        'bad_request',
        `pid ${input.pid} is not a \`${this.options.binaryName} job attach\` process`,
      );
    // THE EXECUTABLE IS PROVED, NOT THE TEXT: a program that merely names itself `fy job attach` runs some other file.
    const executable = await this.proof.executableOf(input.pid).catch(() => 'unknown' as const);
    const trusted = await this.proof.trustedExecutables().catch(() => [] as readonly string[]);
    if (executable === 'unknown' || !trusted.includes(executable))
      throw new JobServiceError(
        'bad_request',
        `pid ${input.pid} does not run the \`${this.options.binaryName}\` executable this daemon knows`,
      );
    const entry: AttachmentEntry = {
      id: this.ids.next(),
      executable,
      sessionId: session.id,
      jobId: job.meta.id,
      pid: input.pid,
      processStart: start === 'unknown' ? `unproved-${input.pid}` : start,
      ...(harness === undefined ? {} : { harness }),
      ...(input.claudeTaskId === undefined ? {} : { claudeTaskId: input.claudeTaskId }),
      registeredAt: instantFromEpochMs(this.clock.now()),
      detaching: false,
    };
    await this.attachments.update(state => withEntry(state, entry));
    return toView(entry);
  }

  async unregisterAttachment(reference: string, id: string): Promise<void> {
    const session = await this.session(reference);
    await this.attachments.update(state =>
      state.entries.some(entry => entry.id === id && entry.sessionId === session.id) ? withoutEntry(state, id) : state,
    );
  }

  async listAttachments(reference: string): Promise<JobAttachmentListView> {
    const session = await this.session(reference);
    return { sessionId: session.id, attachments: (await this.liveAttachments(session.id)).map(toView) };
  }

  /**
   * Asks to detach every attachment whose harness was killed without a word (SIGKILL leaves the shell and the attachment
   * running, reparented): such an orphan reports to nobody. Answers how many it newly asked. Read once per sweep tick.
   */
  async sweepOrphans(): Promise<number> {
    const current = await this.prune();
    const pids = [
      ...new Set(current.entries.flatMap(entry => (entry.harness === undefined ? [] : [entry.harness.pid]))),
    ];
    if (pids.length === 0) return 0;
    const now = new Map<number, string | undefined | 'unknown'>();
    for (const pid of pids) now.set(pid, await this.proof.startOf(pid).catch(() => 'unknown' as const));
    let marked = 0;
    await this.attachments.update(state => {
      const result = withOrphansDetaching(state, now);
      marked = result.marked;
      return result.state;
    });
    return marked;
  }

  // ─── what the moves read (the `jobs.keeper` hook's source) ─────────────────────────────────────────────────────

  /** The proven live attachments of a ferret, with the name of each one's job. */
  async keptAttachments(
    reference: string,
  ): Promise<readonly { pid: number; jobId: string; jobName: string; jobEnded?: boolean }[]> {
    const session = await this.session(reference);
    const [live, rows] = await Promise.all([this.liveAttachments(session.id), this.rows(session.id)]);
    const found = new Map(rows.map(row => [row.meta.id, row]));
    // The gate trusts this list, so each entry's FILE is re-proved now (not only when it registered): the process must still
    // run the executable it registered with, and that must still be the daemon-known `fy`. Anything unreadable drops out.
    const trusted = await this.proof.trustedExecutables().catch(() => [] as readonly string[]);
    const proven = await Promise.all(
      live.map(async entry => {
        if (entry.executable === undefined || !trusted.includes(entry.executable)) return undefined;
        const now = await this.proof.executableOf(entry.pid).catch(() => 'unknown' as const);
        return now === entry.executable ? entry : undefined;
      }),
    );
    return proven.flatMap(entry => {
      if (entry === undefined) return [];
      const row = found.get(entry.jobId);
      if (row === undefined) return [];
      const ended = jobState(row.exit, row.running !== undefined) !== 'running';
      return [{ pid: entry.pid, jobId: entry.jobId, jobName: row.meta.name, ...(ended ? { jobEnded: true } : {}) }];
    });
  }

  private async keptJob(owner: string, row: Row): Promise<KeptJob> {
    const state = jobState(row.exit, row.running !== undefined);
    return {
      id: row.meta.id,
      name: row.meta.name,
      state,
      startedAt: row.meta.startedAt,
      ...(row.exit === undefined ? {} : { endedAt: row.exit.endedAt, exitCode: row.exit.code }),
      unreported: state !== 'running' && !(await this.files.isReported(owner, row.meta.id)),
    };
  }

  /** A ferret's jobs, newest first: what the hand-over lists. */
  async keptJobs(reference: string): Promise<readonly KeptJob[]> {
    const session = await this.session(reference);
    const rows = (await this.rows(session.id)).toSorted((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt));
    return await Promise.all(rows.map(async row => await this.keptJob(session.id, row)));
  }

  async markJobsReported(reference: string, jobIds: readonly string[]): Promise<void> {
    const session = await this.session(reference);
    for (const id of jobIds) await this.files.markReported(session.id, id).catch(() => undefined);
  }

  /**
   * Finished, unreported jobs with no live attachment, ended at least `graceMs` ago — an attachment that was live at the
   * end reports it itself within a poll, so a job this young is left to it.
   */
  async endedUnattached(graceMs: number): Promise<readonly { ferret: string; job: KeptJob }[]> {
    const [rows, live] = await Promise.all([this.rows(), this.liveAttachmentsAll()]);
    const attached = new Set(live.map(entry => `${entry.sessionId}\n${entry.jobId}`));
    const cutoff = this.clock.now() - graceMs;
    const found: { ferret: string; job: KeptJob }[] = [];
    for (const row of rows) {
      if (row.exit === undefined || attached.has(`${row.owner}\n${row.meta.id}`)) continue;
      if (Date.parse(row.exit.endedAt) > cutoff) continue;
      const job = await this.keptJob(row.owner, row);
      if (job.unreported) found.push({ ferret: row.owner, job });
    }
    return found;
  }

  private async liveAttachmentsAll(): Promise<readonly AttachmentEntry[]> {
    return (await this.prune()).entries;
  }

  /**
   * The completion backstop's cut-over instant: written on the first call ever (now) and returned unchanged by every later one,
   * across daemon restarts. `undefined` when it cannot be read or written: the backstop then does nothing this pass rather than
   * guess (a missing cut-over would treat every old job as news).
   */
  async backstopCutOver(): Promise<number | undefined> {
    const state = await this.attachments.update(current => withCutOver(current, this.clock.now()));
    return state.backstopCutOverMs;
  }

  /** Asks every attachment of the ferret (or of one job) to detach: each exits on its next poll; no job is touched. */
  async detachAll(reference: string, jobKey?: string): Promise<number> {
    const session = await this.session(reference);
    const jobId = jobKey === undefined ? undefined : (await this.row(session.id, jobKey)).meta.id;
    const before = await this.liveAttachments(session.id);
    const target = before.filter(entry => (jobId === undefined || entry.jobId === jobId) && !entry.detaching).length;
    await this.attachments.update(state => withDetaching(state, session.id, jobId));
    return target;
  }
}

function toView(entry: AttachmentEntry): JobAttachmentView {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    jobId: entry.jobId,
    pid: entry.pid,
    ...(entry.claudeTaskId === undefined ? {} : { claudeTaskId: entry.claudeTaskId }),
    registeredAt: entry.registeredAt as JobAttachmentView['registeredAt'],
    detaching: entry.detaching,
  };
}
