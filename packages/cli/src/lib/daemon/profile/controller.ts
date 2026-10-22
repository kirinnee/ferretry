import {
  type IFyApiClient,
  PERFORMANCE_PROFILE_DEFAULT_SECONDS,
  PERFORMANCE_PROFILE_MAX_SECONDS,
  PERFORMANCE_PROFILE_MIN_SECONDS,
  PERFORMANCE_PROFILE_PATH,
  type PerformanceProfileView,
  PerformanceProfileViewSchema,
  type PerformanceReport,
  renderPerformanceReport,
  type SyscallTrace,
} from '@ferretry/protocol';
import { z } from 'zod';

/** Flags `fy daemon profile` accepts, as the shell gave them. */
export interface ProfileCommandOptions {
  readonly seconds?: string;
  readonly json?: boolean;
  readonly out?: string;
  readonly traceSyscalls?: boolean;
}

/** The daemon calls the profile command makes. */
export interface IProfileGateway {
  start(seconds: number): Promise<PerformanceProfileView>;
  view(id: string): Promise<PerformanceProfileView>;
  /** The serving daemon's process id, for a tracer; `undefined` when it does not say. */
  pid(): Promise<number | undefined>;
}

/** The outcome of running an outside tracer: its table, or the sentence saying why there is none. */
export type SyscallTraceOutcome =
  | { readonly kind: 'traced'; readonly trace: SyscallTrace }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Runs the platform's tracer against `pid` for `seconds`. */
export interface ISyscallTracer {
  /**
   * Gets permission to trace BEFORE the window opens — a `sudo` password typed while the window runs
   * would cost the trace those seconds. Answers why tracing is impossible, or `undefined` when ready.
   */
  prepare(): Promise<SyscallTraceOutcome | undefined>;
  trace(pid: number, seconds: number): Promise<SyscallTraceOutcome>;
}

interface IProfileOutput {
  report(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

export interface ProfileControllerDeps {
  readonly gateway: IProfileGateway;
  readonly tracer: ISyscallTracer;
  readonly out: IProfileOutput;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly writeFile: (path: string, text: string) => Promise<void>;
}

/** How often a finished window is asked for, and how long past its end before giving up. */
const POLL_MS = 1_000;
const GRACE_MS = 60_000;

/**
 * Drives `fy daemon profile`: opens a window on the daemon, optionally traces its system calls from
 * outside over the same seconds, collects the report and prints it — ranked offenders first — or the
 * protocol document with `--json`. `--out` also writes the document to a file to send.
 */
export class ProfileController {
  constructor(private readonly deps: ProfileControllerDeps) {}

  async run(options: ProfileCommandOptions): Promise<void> {
    const seconds = parseSeconds(options.seconds);
    if (seconds === undefined) {
      this.deps.out.error(
        `--seconds must be a whole number from ${String(PERFORMANCE_PROFILE_MIN_SECONDS)} to ${String(PERFORMANCE_PROFILE_MAX_SECONDS)}`,
      );
      this.deps.out.setExitCode(1);
      return;
    }
    const tracing = options.traceSyscalls === true;
    const refused = tracing ? await this.deps.tracer.prepare() : undefined;
    const pid = tracing && refused === undefined ? await this.deps.gateway.pid().catch(() => undefined) : undefined;
    const started = await this.deps.gateway.start(seconds);
    if (options.json !== true)
      this.deps.out.warn(`profiling the daemon for ${String(seconds)} s — leave it idle for an idle profile…`);
    const traced = !tracing
      ? undefined
      : (refused ??
        (pid === undefined
          ? ({ kind: 'unavailable', reason: 'the daemon did not report its process id' } as const)
          : await this.deps.tracer.trace(pid, seconds)));
    const report = await this.#collect(started);
    if (report === undefined) {
      this.deps.out.error('the daemon did not finish the profile; is it still running? (fy daemon status)');
      this.deps.out.setExitCode(1);
      return;
    }
    const complete: PerformanceReport =
      traced?.kind === 'traced'
        ? { ...report, syscallTrace: traced.trace }
        : traced?.kind === 'unavailable'
          ? { ...report, limitations: [...report.limitations, `No system-call trace: ${traced.reason}.`] }
          : report;
    if (options.out !== undefined) await this.deps.writeFile(options.out, `${JSON.stringify(complete, null, 2)}\n`);
    this.deps.out.report(options.json === true ? JSON.stringify(complete) : renderPerformanceReport(complete));
    if (options.out !== undefined && options.json !== true)
      this.deps.out.report(
        `\nThe full report is in ${options.out}; it holds no content or secrets, so it is safe to send.`,
      );
  }

  async #collect(started: PerformanceProfileView): Promise<PerformanceReport | undefined> {
    if (started.state === 'finished') return started.report;
    const endsAt = Date.parse(started.endsAt);
    const wait = endsAt - this.deps.now();
    if (wait > 0) await this.deps.sleep(wait);
    const deadline = endsAt + GRACE_MS;
    for (;;) {
      const view = await this.deps.gateway.view(started.id);
      if (view.state === 'finished') return view.report;
      if (this.deps.now() >= deadline) return undefined;
      await this.deps.sleep(POLL_MS);
    }
  }
}

function parseSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) return PERFORMANCE_PROFILE_DEFAULT_SECONDS;
  if (!/^\d+$/u.test(raw.trim())) return undefined;
  const seconds = Number(raw);
  return seconds < PERFORMANCE_PROFILE_MIN_SECONDS || seconds > PERFORMANCE_PROFILE_MAX_SECONDS ? undefined : seconds;
}

/** The liveness answer's process id, the one field the tracer needs. */
const LivenessPidSchema = z.object({ pid: z.number().int().positive().optional() }).passthrough();

/** Starts and reads profiles through the protocol client, parsing every answer. */
export class ProtocolProfileGateway implements IProfileGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request'>) {}

  async start(seconds: number): Promise<PerformanceProfileView> {
    return await this.client.request(PERFORMANCE_PROFILE_PATH, PerformanceProfileViewSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seconds }),
    });
  }

  async view(id: string): Promise<PerformanceProfileView> {
    return await this.client.request(`/v1/diagnostics/profile/${encodeURIComponent(id)}`, PerformanceProfileViewSchema);
  }

  async pid(): Promise<number | undefined> {
    return (await this.client.request('/healthz', LivenessPidSchema)).pid;
  }
}
