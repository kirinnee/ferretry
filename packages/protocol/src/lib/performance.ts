import { z } from 'zod';

/**
 * THE DAEMON'S PERFORMANCE REPORT — what `fy daemon profile` and Settings › Machine › Diagnostics ›
 * "Performance report" hand a person to send to whoever is looking into a slow machine.
 *
 * IT IS MADE TO BE SHARED, so it carries no content and nothing secret: no session text, no command
 * arguments, no file contents and no raw paths. A file is named by its PATTERN (`~/.ferretry/state/
 * sessions/<session>/state.json`), a child process by its program and subcommand (`tmux capture-pane`),
 * a route by its pattern (`GET /v1/sessions/:id`), and a stack by function names and the workspace-
 * relative file they are in. A person can read the whole document before sending it, and should be
 * able to send it to anyone.
 *
 * EVERY SECTION IS A WINDOW. The report covers the seconds between `startedAt` and `endedAt` and
 * nothing before them, so two reports taken minutes apart can be compared, and "per minute" means
 * per minute of that window.
 */

/** The version of this document's shape. A reader refuses a version it does not know. */
export const PERFORMANCE_REPORT_VERSION = 1;

/** The shortest and longest window a profile may cover, and the one `fy daemon profile` takes. */
export const PERFORMANCE_PROFILE_MIN_SECONDS = 5;
export const PERFORMANCE_PROFILE_MAX_SECONDS = 300;
export const PERFORMANCE_PROFILE_DEFAULT_SECONDS = 30;

/** How a set of durations was distributed, in milliseconds. */
export const DurationStatsSchema = z.object({
  totalMs: z.number().nonnegative(),
  p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
});
export type DurationStats = z.infer<typeof DurationStatsSchema>;

/** One labelled piece of background work — a timer's tick, a housekeeping job, a boot step. */
export const ActivityStatsSchema = z.object({
  name: z.string().min(1),
  count: z.number().int().nonnegative(),
  perMinute: z.number().nonnegative(),
  wall: DurationStatsSchema,
});
export type ActivityStats = z.infer<typeof ActivityStatsSchema>;

/** One API route, by its pattern, over every carrier. */
export const RouteStatsSchema = z.object({
  route: z.string().min(1),
  count: z.number().int().nonnegative(),
  perMinute: z.number().nonnegative(),
  /** Answers with a status of 400 or more. */
  errors: z.number().int().nonnegative(),
  wall: DurationStatsSchema,
  /** Response body bytes, summed and at most. */
  bytes: z.object({ total: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
});
export type RouteStats = z.infer<typeof RouteStatsSchema>;

/** One program the daemon started, by program and subcommand only. */
export const ChildProcessStatsSchema = z.object({
  command: z.string().min(1),
  count: z.number().int().nonnegative(),
  perMinute: z.number().nonnegative(),
  /** How many were started synchronously, holding the event loop until they exited. */
  synchronous: z.number().int().nonnegative(),
  /** From start to exit, for the ones that exited inside the window. */
  wall: DurationStatsSchema,
  /**
   * The labelled work that started them — the innermost timer or job in flight (`turn watcher`,
   * `fleet refresh`) — busiest first. `(no named work)` counts children started outside any.
   */
  by: z.array(z.object({ activity: z.string().min(1), count: z.number().int().nonnegative() })).optional(),
});
export type ChildProcessStats = z.infer<typeof ChildProcessStatsSchema>;

/** One kind of file operation on one path pattern, as the daemon's own file ports saw it. */
export const FileOperationStatsSchema = z.object({
  operation: z.string().min(1),
  path: z.string().min(1),
  count: z.number().int().nonnegative(),
  perSecond: z.number().nonnegative(),
  wall: DurationStatsSchema,
});
export type FileOperationStats = z.infer<typeof FileOperationStatsSchema>;

/** One function the sampled stacks spent time in. */
export const HotFunctionSchema = z.object({
  frame: z.string().min(1),
  samples: z.number().int().nonnegative(),
  /** Its share of every sample in the window, 0 to 1. */
  share: z.number().min(0).max(1),
});
export type HotFunction = z.infer<typeof HotFunctionSchema>;

/** One distinct stack, innermost frames first. */
export const HotStackSchema = z.object({
  stack: z.string().min(1),
  samples: z.number().int().nonnegative(),
  share: z.number().min(0).max(1),
});
export type HotStack = z.infer<typeof HotStackSchema>;

/** One period the event loop could not run anything, with what ran and where the samples were. */
export const ReportedStallSchema = z.object({
  /** Milliseconds after the window started. */
  atOffsetMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  during: z.array(z.string()),
  stacks: z.array(z.object({ stack: z.string(), share: z.number().min(0).max(1) })),
});
export type ReportedStall = z.infer<typeof ReportedStallSchema>;

/** A gauge sampled through the window. */
export const GaugeStatsSchema = z.object({
  min: z.number(),
  mean: z.number(),
  max: z.number(),
});
export type GaugeStats = z.infer<typeof GaugeStatsSchema>;

/**
 * The work one worker thread did in the window, AS IT REPORTED IT. The daemon's own instruments count the
 * main thread's `Bun.spawn` and its file ports, and see nothing a worker does; a worker that starts
 * children or reads files says so after each job, and this is that account.
 */
export const WorkerWorkSchema = z.object({
  jobs: z.number().int().nonnegative(),
  perMinute: z.number().nonnegative(),
  wall: DurationStatsSchema,
  /** Programs the worker started, by program and subcommand; `by` is the main-thread work that asked. */
  childProcesses: z.array(ChildProcessStatsSchema),
  fileReads: z.number().int().nonnegative(),
  /** HTTP requests the worker made. */
  fetches: z.number().int().nonnegative(),
  /** The worker's own JavaScript heap after each job. The process's RSS cannot be split by thread. */
  heapMb: GaugeStatsSchema,
});
export type WorkerWork = z.infer<typeof WorkerWorkSchema>;

/** One worker thread's queue, sampled through the window, and what it reported doing. */
export const WorkerStatsSchema = z.object({
  name: z.string().min(1),
  /** Requests waiting for or held by the worker. */
  inFlight: GaugeStatsSchema,
  /** Absent for a worker that reports nothing of its own, or did no job in the window. */
  work: WorkerWorkSchema.optional(),
});
export type WorkerStats = z.infer<typeof WorkerStatsSchema>;

/** One counted syscall shape from an outside tracer (`strace`, `fs_usage`). */
export const TracedSyscallSchema = z.object({
  call: z.string().min(1),
  path: z.string().min(1),
  count: z.number().int().nonnegative(),
  perSecond: z.number().nonnegative(),
});
export type TracedSyscall = z.infer<typeof TracedSyscallSchema>;

/**
 * What an OUTSIDE tracer saw of the daemon and its children over the same window.
 *
 * Added by `fy daemon profile --trace-syscalls`, never by the daemon: a process cannot trace its own
 * system calls, and a tracer needs the operator's permission (ptrace, or `sudo fs_usage` on macOS).
 */
export const SyscallTraceSchema = z.object({
  tool: z.enum(['strace', 'fs_usage']),
  seconds: z.number().positive(),
  total: z.number().int().nonnegative(),
  perSecond: z.number().nonnegative(),
  /** Every call shape, busiest first, cut to the top ones. */
  top: z.array(TracedSyscallSchema),
  /** Programs started, by program and subcommand, as the tracer saw their `execve`. */
  executions: z.array(z.object({ command: z.string().min(1), count: z.number().int().nonnegative() })),
});
export type SyscallTrace = z.infer<typeof SyscallTraceSchema>;

/** One budget the product holds an idle daemon to, and how this window measured against it. */
export const BudgetVerdictSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1),
  limit: z.number().nonnegative(),
  actual: z.number().nonnegative(),
  ok: z.boolean(),
});
export type BudgetVerdict = z.infer<typeof BudgetVerdictSchema>;

export const PerformanceReportSchema = z.object({
  version: z.literal(PERFORMANCE_REPORT_VERSION),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  windowMs: z.number().positive(),
  daemon: z.object({
    version: z.string(),
    platform: z.string(),
    arch: z.string(),
    runtime: z.string(),
    uptimeSeconds: z.number().nonnegative(),
  }),
  /** How big the fleet was when the window ended; absent where the index could not be read. */
  fleet: z.object({ sessions: z.number().int().nonnegative(), running: z.number().int().nonnegative() }).optional(),
  resources: z.object({
    cpu: z.object({
      userMs: z.number().nonnegative(),
      systemMs: z.number().nonnegative(),
      /** User and system time over the window, as a percentage of one core. */
      percentOfCore: z.number().nonnegative(),
      /** CPU used by children that exited inside the window (Linux only). */
      childrenMs: z.number().nonnegative().optional(),
    }),
    memory: z.object({
      rssMb: GaugeStatsSchema,
      heapUsedMb: GaugeStatsSchema,
      externalMb: GaugeStatsSchema,
    }),
    /** Read and write system calls of the daemon itself, sockets included (Linux only). */
    syscalls: z
      .object({ reads: z.number().int().nonnegative(), writes: z.number().int().nonnegative(), perSecond: z.number() })
      .optional(),
    contextSwitches: z.object({
      voluntary: z.number().int().nonnegative(),
      involuntary: z.number().int().nonnegative(),
    }),
  }),
  eventLoop: z.object({
    ticks: z.number().int().nonnegative(),
    lag: z.object({ p50Ms: z.number(), p95Ms: z.number(), maxMs: z.number() }),
    blocksOver100Ms: z.number().int().nonnegative(),
    blocksOver250Ms: z.number().int().nonnegative(),
    blockedMs: z.number().nonnegative(),
    /** The longest stalls, longest first. */
    stalls: z.array(ReportedStallSchema),
  }),
  /** Where the sampled main-thread stacks spent the window; empty when the sampler is off. */
  cpuProfile: z.object({
    samples: z.number().int().nonnegative(),
    self: z.array(HotFunctionSchema),
    inclusive: z.array(HotFunctionSchema),
    stacks: z.array(HotStackSchema),
  }),
  activities: z.array(ActivityStatsSchema),
  routes: z.array(RouteStatsSchema),
  childProcesses: z.object({
    total: z.number().int().nonnegative(),
    perMinute: z.number().nonnegative(),
    commands: z.array(ChildProcessStatsSchema),
  }),
  fileOperations: z.object({
    total: z.number().int().nonnegative(),
    perSecond: z.number().nonnegative(),
    top: z.array(FileOperationStatsSchema),
  }),
  workers: z.array(WorkerStatsSchema),
  budgets: z.array(BudgetVerdictSchema),
  syscallTrace: SyscallTraceSchema.optional(),
  /** What this report cannot see, in sentences, so a reader does not mistake a gap for a zero. */
  limitations: z.array(z.string()),
});
export type PerformanceReport = z.infer<typeof PerformanceReportSchema>;

/** Asks the daemon to profile itself for `seconds`. */
export const PerformanceProfileRequestSchema = z.object({
  seconds: z.number().int().min(PERFORMANCE_PROFILE_MIN_SECONDS).max(PERFORMANCE_PROFILE_MAX_SECONDS),
});
export type PerformanceProfileRequest = z.infer<typeof PerformanceProfileRequestSchema>;

/**
 * A profile, running or finished.
 *
 * A PROFILE IS STARTED, THEN READ, rather than answered by one long request: a 30-second request over a
 * relay or a phone's flaky radio is one dropped connection away from losing the whole window. The start
 * answers at once with an id; the reader asks again until the report is there.
 */
export const PerformanceProfileViewSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('running'),
    id: z.string().min(1),
    startedAt: z.string().min(1),
    endsAt: z.string().min(1),
  }),
  z.object({ state: z.literal('finished'), id: z.string().min(1), report: PerformanceReportSchema }),
]);
export type PerformanceProfileView = z.infer<typeof PerformanceProfileViewSchema>;

/** The path a profile is started on; it is read back at `<path>/:id`. */
export const PERFORMANCE_PROFILE_PATH = '/v1/diagnostics/profile';
