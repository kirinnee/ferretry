import type { TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import {
  claudeTaskId,
  JOB_EXIT_DETACHED,
  JOB_EXIT_LOST,
  JOB_EXIT_TIMED_OUT,
  type JobAttachmentView,
  JobAttachmentViewSchema,
  type JobListView,
  JobListViewSchema,
  type JobOutputView,
  JobOutputViewSchema,
  type JobView,
  JobViewSchema,
} from '../../../contract/index.ts';
import { UsageError, Words, wholeNumber } from '../args.ts';
import type { IJobGateway, IJobProcess, IJobSignals, IJobTimers } from './ports.ts';
import { commandFromWords, parseDuration } from './words.ts';

const ROUTES = {
  list: 'GET /v1/ferrets/:ferretId/jobs',
  start: 'POST /v1/ferrets/:ferretId/jobs',
  get: 'GET /v1/ferrets/:ferretId/jobs/:jobId',
  output: 'GET /v1/ferrets/:ferretId/jobs/:jobId/output',
  stop: 'POST /v1/ferrets/:ferretId/jobs/:jobId/stop',
  register: 'POST /v1/ferrets/:ferretId/job-attachments',
  unregister: 'DELETE /v1/ferrets/:ferretId/job-attachments/:attachmentId',
} as const;

/** How often an attachment asks for more log. */
const JOB_POLL_MS = 300;
/** Consecutive failed polls (the daemon down or restarting) before an attachment gives up and detaches. */
const JOB_MAX_POLL_FAILURES = 40;
/**
 * How long the attachment's goodbye to the daemon (the unregister) may take. A signal gives this process about a second to end
 * (Claude follows its TERM with a KILL ~1.5 s later), so the daemon is not waited for beyond this; a stale entry is pruned
 * by pid + start.
 */
const JOB_UNREGISTER_MS = 300;
/** The lines `attach` shows first when neither --from-start nor --tail is given. */
const JOB_DEFAULT_TAIL = 100;
/** `ls` without --all shows the running jobs and this many of the latest finished ones. */
const JOB_LS_FINISHED = 10;

/** The signals a verb listens for: one abort for every call it makes, and whether one was heard. */
interface Heard {
  readonly signal: AbortSignal;
  heard(): boolean;
  release(): void;
}

/**
 * The `fy job` verbs. The job lives in the KEEPER (the daemon-owned tmux server); what this runs is only an ATTACHMENT, which
 * a signal, a move or a dead daemon may break at any time without touching the job. Each verb answers its exit code.
 */
export class JobVerbs {
  constructor(
    private readonly gateway: IJobGateway,
    private readonly io: TerminalIo,
    private readonly host: {
      readonly self: IJobProcess;
      readonly signals: IJobSignals;
      readonly timers: IJobTimers;
      /** `FY_SESSION_ID`: the ferret this runs inside. */
      readonly sessionId: string | undefined;
    },
  ) {}

  // ─── verbs ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async run(invocation: VerbInvocation): Promise<number> {
    return await this.guard(async () => {
      const words = new Words(invocation);
      const session = this.session(words);
      if (words.args.length === 0) throw new UsageError('give a command after --: fy job run --name build -- bun test');
      const name = words.text('name');
      // Listening starts BEFORE the start request, so a TERM that lands while it is in flight detaches (75) like any other.
      const heard = this.hear();
      let job: JobView;
      try {
        job = JobViewSchema.parse(
          await this.raced(
            heard,
            this.gateway.call(ROUTES.start, {
              params: { ferretId: session },
              body: {
                command: commandFromWords(words.args),
                cwd: this.host.self.cwd(),
                ...(name === undefined ? {} : { name }),
              },
              signal: heard.signal,
            }),
          ),
        );
      } catch (error) {
        heard.release();
        if (!heard.heard()) throw error;
        this.io.err('detached before the daemon confirmed the job started; if it did, fy job ls shows it\n');
        return this.leave();
      }
      this.io.err(`started job ${job.id} (${job.name})\n`);
      return await this.follow(session, job, { from: 0 }, heard);
    });
  }

  async attach(invocation: VerbInvocation): Promise<number> {
    return await this.guard(async () => {
      const words = new Words(invocation);
      const session = this.session(words);
      const key = this.key(words);
      const heard = this.hear();
      let job: JobView;
      try {
        job = await this.raced(heard, this.job(session, key, heard.signal));
      } catch (error) {
        heard.release();
        if (!heard.heard()) throw error;
        return this.leaveJob({ id: key, name: key });
      }
      const first = words.on('from-start') ? { from: 0 } : { tail: this.tail(words) ?? JOB_DEFAULT_TAIL };
      return await this.follow(session, job, first, heard);
    });
  }

  async logs(invocation: VerbInvocation): Promise<number> {
    return await this.guard(async () => {
      const words = new Words(invocation);
      const session = this.session(words);
      const job = await this.job(session, this.key(words));
      const tail = this.tail(words);
      let request: { from?: number; tail?: number } = tail === undefined ? { from: 0 } : { tail };
      for (;;) {
        const out = await this.output(session, job.id, request);
        if (out.text !== '') this.io.out(out.text);
        if (out.next >= out.size || (out.text === '' && out.next === (request.from ?? -1))) return 0;
        request = { from: out.next };
      }
    });
  }

  async wait(invocation: VerbInvocation): Promise<number> {
    return await this.guard(async () => {
      const words = new Words(invocation);
      const session = this.session(words);
      const key = this.key(words);
      const timeoutText = words.text('timeout');
      const timeoutMs = timeoutText === undefined ? undefined : parseDuration(timeoutText);
      if (timeoutText !== undefined && timeoutMs === undefined)
        throw new UsageError(`--timeout must look like 30, 30s, 5m or 2h, not "${timeoutText}"`);
      const heard = this.hear();
      const deadline = timeoutMs === undefined ? undefined : this.host.timers.nowMs() + timeoutMs;
      try {
        for (;;) {
          let job: JobView;
          try {
            job = await this.raced(heard, this.job(session, key, heard.signal));
          } catch (error) {
            if (heard.heard()) return this.detached({ id: key, name: key });
            throw error;
          }
          if (job.state !== 'running') {
            this.io.out(`${this.describeEnd(job)}\n`);
            return this.exitCodeOf(job);
          }
          if (heard.heard()) return this.detached(job);
          if (deadline !== undefined && this.host.timers.nowMs() >= deadline) {
            this.io.err(`job ${job.id} (${job.name}) is still running after ${timeoutText}\n`);
            return JOB_EXIT_TIMED_OUT;
          }
          await this.host.timers.sleep(JOB_POLL_MS, heard.signal);
        }
      } finally {
        heard.release();
        if (heard.heard()) this.host.self.exit(JOB_EXIT_DETACHED);
      }
    });
  }

  async stopJob(invocation: VerbInvocation): Promise<number> {
    return await this.guard(async () => {
      const words = new Words(invocation);
      const session = this.session(words);
      const job = JobViewSchema.parse(
        await this.gateway.call(ROUTES.stop, { params: { ferretId: session, jobId: this.key(words) } }),
      );
      if (job.state === 'running') {
        this.io.err(`job ${job.id} (${job.name}) is still running; it did not stop in time\n`);
        return 1;
      }
      this.io.out(`${this.describeEnd(job)}\n`);
      return 0;
    });
  }

  async ls(invocation: VerbInvocation): Promise<number> {
    return await this.guard(async () => {
      const words = new Words(invocation);
      const session = this.session(words);
      const view: JobListView = JobListViewSchema.parse(
        await this.gateway.call(ROUTES.list, { params: { ferretId: session } }),
      );
      const running = view.jobs.filter(job => job.state === 'running');
      const finished = view.jobs.filter(job => job.state !== 'running');
      const shown = words.on('all') ? view.jobs : [...running, ...finished.slice(0, JOB_LS_FINISHED)];
      if (words.on('json')) {
        this.io.out(`${JSON.stringify({ ...view, jobs: shown }, null, 2)}\n`);
        return 0;
      }
      if (shown.length === 0) {
        this.io.out('no jobs\n');
        return 0;
      }
      const rows = shown.map(job => [
        job.id,
        job.name,
        job.state === 'running' ? 'running' : job.state === 'lost' ? 'lost' : `exit ${job.exitCode ?? '?'}`,
        this.age(job),
        job.command.length > 60 ? `${job.command.slice(0, 57)}...` : job.command,
      ]);
      const header = ['ID', 'NAME', 'STATE', 'AGE', 'COMMAND'];
      const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map(row => row[index]?.length ?? 0)));
      const line = (cells: readonly string[]): string =>
        cells.map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join('  ');
      this.io.out(`${[line(header), ...rows.map(line)].join('\n')}\n`);
      const hidden = view.jobs.length - shown.length;
      if (hidden > 0) this.io.out(`(${hidden} older finished job${hidden === 1 ? '' : 's'} hidden: fy job ls --all)\n`);
      return 0;
    });
  }

  // ─── the attachment ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Streams the log until the job ends, then answers its exit code. A signal, the daemon asking this attachment to let go,
   * or a daemon that stays out of reach DETACHES: it says so on stderr and answers {@link JOB_EXIT_DETACHED}. It never
   * signals the job, and it never forwards the signal it heard.
   *
   * A signal must end the process within about a second, so every call carries the signal's abort (a request in flight is
   * cancelled, not merely outrun), the goodbye to the daemon is bounded, and the process ends itself once detached.
   */
  private async follow(
    session: string,
    job: JobView,
    first: { from?: number; tail?: number },
    heard: Heard,
  ): Promise<number> {
    const attachment = await this.raced(heard, this.register(session, job, heard.signal)).catch(() => undefined);
    try {
      let request: { from?: number; tail?: number } = first;
      let failures = 0;
      for (;;) {
        if (heard.heard()) return this.detached(job);
        let out: JobOutputView;
        try {
          out = await this.raced(heard, this.output(session, job.id, request, attachment?.id, heard.signal));
          failures = 0;
        } catch (error) {
          if (heard.heard()) return this.detached(job);
          failures += 1;
          if (failures >= JOB_MAX_POLL_FAILURES) {
            this.io.err(`lost contact with the daemon (${error instanceof Error ? error.message : String(error)})\n`);
            return this.detached(job);
          }
          await this.host.timers.sleep(Math.min(2_000, JOB_POLL_MS * failures), heard.signal);
          continue;
        }
        if (out.text !== '') this.io.out(out.text);
        request = { from: out.next };
        if (out.detach) return this.detached(out.job);
        if (out.ended) {
          if (out.job.state === 'lost')
            this.io.err(`job ${out.job.id} (${out.job.name}) ended without recording an exit (the host restarted?)\n`);
          return this.exitCodeOf(out.job);
        }
        await this.host.timers.sleep(JOB_POLL_MS, heard.signal);
      }
    } finally {
      heard.release();
      // Told, but only for a moment: the daemon may not be answering, and nothing may keep this process past its deadline.
      if (attachment !== undefined) {
        const told = this.gateway
          .call(ROUTES.unregister, {
            params: { ferretId: session, attachmentId: attachment.id },
            signal: this.host.timers.deadline(JOB_UNREGISTER_MS),
          })
          .catch(() => undefined);
        // The deadline also cancels the request; the race is for a gateway that does not honour a signal.
        await Promise.race([told, this.host.timers.sleep(JOB_UNREGISTER_MS)]);
      }
      if (heard.heard()) this.host.self.exit(JOB_EXIT_DETACHED);
    }
  }

  /** Starts hearing TERM/HUP/INT: `signal` aborts on the first one, and every call the verb makes carries it. */
  private hear(): Heard {
    const abort = new AbortController();
    let heard = false;
    const release = this.host.signals.listen(() => {
      heard = true;
      abort.abort();
    });
    return { signal: abort.signal, heard: () => heard, release };
  }

  /** `work`, or a rejection the moment a signal is heard, whether or not `work` honours the abort. */
  private async raced<T>(heard: Heard, work: Promise<T>): Promise<T> {
    if (heard.signal.aborted) {
      work.catch(() => undefined);
      throw new Error('interrupted');
    }
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('interrupted'));
      heard.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([work, interrupted]);
    } finally {
      if (onAbort !== undefined) heard.signal.removeEventListener('abort', onAbort);
      work.catch(() => undefined);
    }
  }

  /** Tells the daemon this attachment exists. Best effort: an attachment the daemon does not know still streams. */
  private async register(session: string, job: JobView, signal: AbortSignal): Promise<JobAttachmentView | undefined> {
    const file = this.host.self.stdoutFile();
    const task = file === undefined ? undefined : claudeTaskId(file);
    try {
      return JobAttachmentViewSchema.parse(
        await this.gateway.call(ROUTES.register, {
          params: { ferretId: session },
          body: { jobId: job.id, pid: this.host.self.pid, ...(task === undefined ? {} : { claudeTaskId: task }) },
          signal,
        }),
      );
    } catch {
      return undefined;
    }
  }

  private detached(job: { readonly id: string; readonly name: string }): number {
    this.io.err(
      `detached from job ${job.id} (${job.name}); it is still running — re-attach with: fy job attach ${job.id}\n`,
    );
    return JOB_EXIT_DETACHED;
  }

  /** A detach on a signal where no `follow` runs: say so, and end the process at once (nothing it left open may hold it). */
  private leaveJob(job: { readonly id: string; readonly name: string }): number {
    this.detached(job);
    return this.leave();
  }

  private leave(): number {
    this.host.self.exit(JOB_EXIT_DETACHED);
    return JOB_EXIT_DETACHED;
  }

  // ─── reading ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async output(
    session: string,
    jobId: string,
    request: { from?: number; tail?: number },
    attachment?: string,
    signal?: AbortSignal,
  ): Promise<JobOutputView> {
    return JobOutputViewSchema.parse(
      await this.gateway.call(ROUTES.output, {
        params: { ferretId: session, jobId },
        query: {
          ...(request.from === undefined ? {} : { from: String(request.from) }),
          ...(request.tail === undefined ? {} : { tail: String(request.tail) }),
          ...(attachment === undefined ? {} : { attachment }),
        },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  }

  private async job(session: string, key: string, signal?: AbortSignal): Promise<JobView> {
    return JobViewSchema.parse(
      await this.gateway.call(ROUTES.get, {
        params: { ferretId: session, jobId: key },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  }

  private exitCodeOf(job: JobView): number {
    return job.state === 'exited' ? Math.min(255, job.exitCode ?? 0) : JOB_EXIT_LOST;
  }

  private describeEnd(job: JobView): string {
    if (job.state === 'lost') return `job ${job.id} (${job.name}) ended without recording an exit`;
    const how = job.signal === undefined ? `exit code ${job.exitCode}` : `exit code ${job.exitCode} (SIG${job.signal})`;
    return `job ${job.id} (${job.name}) ended: ${how}`;
  }

  private age(job: JobView): string {
    const seconds = Math.max(0, Math.round((this.host.timers.nowMs() - Date.parse(job.startedAt)) / 1_000));
    if (seconds < 90) return `${seconds}s`;
    if (seconds < 5_400) return `${Math.round(seconds / 60)}m`;
    if (seconds < 172_800) return `${Math.round(seconds / 3_600)}h`;
    return `${Math.round(seconds / 86_400)}d`;
  }

  // ─── words ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private session(words: Words): string {
    const session = words.text('session', 's') ?? this.host.sessionId;
    if (session === undefined || session.trim() === '')
      throw new UsageError('this is not running inside a ferret: pass --session <id>');
    return session.trim();
  }

  private key(words: Words): string {
    const key = words.args[0];
    if (key === undefined) throw new UsageError('name the job: its name or id (fy job ls lists them)');
    return key;
  }

  private tail(words: Words): number | undefined {
    const text = words.text('tail');
    return text === undefined ? undefined : wholeNumber(text, '--tail');
  }

  private async guard(run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      this.io.err(`${error instanceof Error ? error.message : String(error)}\n`);
      return error instanceof UsageError ? 2 : 1;
    }
  }
}
