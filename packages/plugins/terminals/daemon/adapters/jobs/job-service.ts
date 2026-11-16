/**
 * The job keeper's lifecycle (docs/jobs.md). It owns no process: the wrapper in a tmux pane runs the command and records its
 * exit, and everything this service reports is DERIVED from those files and the tmux listing — so a fresh instance (a daemon
 * restart) reads exactly what the old one did.
 */
import { instantFromEpochMs } from '@ferretry/std';
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
import type { TerminalClock, TerminalIdSource, TerminalSessionResolver } from '../../lib/terminal/contracts.ts';
import {
  type AttachmentEntry,
  entriesOf,
  withDetaching,
  withEntry,
  withoutEntry,
  withoutStale,
} from '../../lib/jobs/attachments.ts';
import type { AttachmentStore, JobFilesPort, JobRuntimePort, ProcessProof, RunningJob } from '../../lib/jobs/contracts.ts';
import {
  checkJobCapacity,
  defaultJobName,
  findJob,
  JOB_STOP_GRACE_SECONDS,
  JobPolicyError,
  jobsToDelete,
  jobState,
  signalOfCode,
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
  /** Told when a job started or was stopped (the daemon log line). */
  readonly onEvent?: (event: { readonly kind: 'started' | 'stopped' | 'removed'; readonly sessionId: string; readonly jobId: string }) => void;
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
    if (!session || !session.cwd.startsWith('/')) throw new JobServiceError('not_found', 'job session not found');
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
    const ordered = [...rows.filter(row => row.running !== undefined), ...rows.filter(row => row.running === undefined)];
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
    if (request.from === undefined && request.tail !== undefined) from = await this.tailStart(session.id, row.meta.id, size, request.tail, finished);
    const bytes = await this.files.readOutput(session.id, row.meta.id, from, Math.min(JOB_OUTPUT_CHUNK_BYTES, size - from));
    let end = bytes.byteLength;
    if (!(finished && from + end >= size)) {
      // Not the log's end, or the job still runs: stop after the last newline so a line is never split between polls.
      const lastNewline = bytes.lastIndexOf(0x0a);
      end = lastNewline === -1 ? (bytes.byteLength >= JOB_OUTPUT_CHUNK_BYTES ? bytes.byteLength : 0) : lastNewline + 1;
    }
    const next = from + end;
    const attachments = await this.liveAttachments(session.id);
    const mine = request.attachment === undefined ? undefined : attachments.find(entry => entry.id === request.attachment);
    return {
      text: new TextDecoder().decode(bytes.subarray(0, end)),
      next,
      size,
      job: await this.view(session.id, row, attachments),
      ended: finished && next >= size,
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
    try {
      checkJobCapacity({
        ferret: running.filter(job => job.owner === session.id).length,
        global: running.length,
      });
    } catch (error) {
      if (error instanceof JobPolicyError) throw new JobServiceError(error.code, error.message);
      throw error;
    }
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
   * Stops a job's tree: the wrapper turns the stop request into SIGTERM, then SIGKILL after the grace. If the wrapper itself does
   * not finish in time the pane is taken down and a KILL exit is recorded here. A job already ended is answered as it is.
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

  /** Whether the shell-style code of an ended job is a signal death (for display only). */
  static signalOf(view: JobView): number | undefined {
    return view.exitCode === undefined ? undefined : signalOfCode(view.exitCode);
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
    for (const entry of current.entries) starts.set(entry.pid, await this.proof.startOf(entry.pid).catch(() => 'unknown' as const));
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
    if (start === undefined) throw new JobServiceError('bad_request', `pid ${input.pid} is not a running process`);
    const entry: AttachmentEntry = {
      id: this.ids.next(),
      sessionId: session.id,
      jobId: job.meta.id,
      pid: input.pid,
      processStart: start === 'unknown' ? `unproved-${input.pid}` : start,
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
