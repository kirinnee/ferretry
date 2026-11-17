/**
 * Jobs' wire (docs/jobs.md): a job is a non-interactive command the KEEPER (the daemon-owned tmux server) runs for a
 * ferret, so it outlives the agent's process tree. The agent holds only an ATTACHMENT — a `fy job attach` client —
 * that may be broken at any time without touching the job.
 *
 * A job's TEXT (its log) never appears in a view here; it leaves only through the output route's `Redaction.read`.
 */
import { InstantSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';

// ─── exit codes of the `fy job` verbs ─────────────────────────────────────────────────────────────────────────────

/**
 * What `fy job attach|run` exits with when the ATTACHMENT broke but the job did not: a signal (SIGTERM, SIGHUP, SIGINT),
 * the daemon asking it to detach (a move), or the daemon staying out of reach. BSD `EX_TEMPFAIL`: "try again".
 */
export const JOB_EXIT_DETACHED = 75;
/** `fy job wait --timeout` ran out (the `timeout(1)` convention). */
export const JOB_EXIT_TIMED_OUT = 124;
/** The job ended without leaving an exit record (the host or the tmux server went away under it). */
export const JOB_EXIT_LOST = 70;

// ─── limits ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Running jobs one ferret may hold. Jobs do NOT use terminal slots: they are their own tmux sessions with their own cap. */
export const JOB_MAX_RUNNING_PER_FERRET = 8;
/** Running jobs across every ferret on the machine. */
export const JOB_MAX_RUNNING_GLOBAL = 48;
/** How long a finished job's files are kept. */
export const JOB_RETENTION_DAYS = 7;
/** How many finished jobs a ferret keeps (the newest); older ones go even inside the retention window. */
export const JOB_RETENTION_FINISHED_PER_FERRET = 50;
/** The most log bytes one output answer carries. */
export const JOB_OUTPUT_CHUNK_BYTES = 256 * 1024;
/** The longest command line a job takes. */
export const JOB_MAX_COMMAND_LENGTH = 16_384;

// ─── names ────────────────────────────────────────────────────────────────────────────────────────────────────────

const JOB_ID_SHAPE = /^[a-f0-9]{12}$/u;
export const JOB_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

/** A job's name: a lowercase letter, then up to 31 lowercase letters, digits or dashes; never shaped like an id. */
export const JobNameSchema = z
  .string()
  .regex(JOB_NAME_PATTERN, 'a name is a lowercase letter, then up to 31 lowercase letters, digits or dashes')
  .refine(value => !JOB_ID_SHAPE.test(value), 'a name may not look like a job id (twelve hex characters)');

/** A job's name or id as typed. */
export const JobKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u, 'not a job name or id');

// ─── documents the keeper keeps on disk ───────────────────────────────────────────────────────────────────────────

/** Who started a job: a ferret itself, or a person (a paired device or somebody at this machine) for that ferret. */
export const JobStartedBySchema = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('agent'), sessionId: z.string().min(1).max(128) }),
  z.strictObject({ by: z.literal('person') }),
]);
export type JobStartedBy = z.infer<typeof JobStartedBySchema>;

/** `job.json`: written by the daemon once, before the command starts. */
export const JobMetaSchema = z.strictObject({
  id: z.string().regex(JOB_ID_SHAPE),
  name: JobNameSchema,
  command: z.string().min(1).max(JOB_MAX_COMMAND_LENGTH),
  cwd: z.string().startsWith('/'),
  startedAt: InstantSchema,
  startedBy: JobStartedBySchema,
});
export type JobMeta = z.infer<typeof JobMetaSchema>;

/**
 * `exit.json`: written by the WRAPPER in the pane (never the daemon), atomically, so an exit is recorded even when the
 * daemon is down when the job ends. `signal` is the name (`TERM`) when the job's code reads as a signal death.
 */
export const JobExitSchema = z.strictObject({
  code: NonNegativeIntegerSchema,
  signal: z
    .string()
    .regex(/^[A-Z0-9]{1,12}$/u)
    .optional(),
  endedAt: InstantSchema,
});
export type JobExit = z.infer<typeof JobExitSchema>;

// ─── views ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `running`; `exited` (an exit record exists); `lost` (it stopped leaving none). */
export const JobStateSchema = z.enum(['running', 'exited', 'lost']);
export type JobState = z.infer<typeof JobStateSchema>;

export const JobViewSchema = z.strictObject({
  id: z.string().regex(JOB_ID_SHAPE),
  sessionId: z.string(),
  name: JobNameSchema,
  command: z.string(),
  cwd: z.string(),
  state: JobStateSchema,
  startedAt: InstantSchema,
  startedBy: JobStartedBySchema,
  /** Present once it ended. A signal death reads 128 + the signal's number, as a shell reports it. */
  exitCode: NonNegativeIntegerSchema.optional(),
  signal: z.string().optional(),
  endedAt: InstantSchema.optional(),
  /** The log's size in bytes right now. */
  outputBytes: NonNegativeIntegerSchema,
  /** How many live attachments the daemon knows of. */
  attachments: NonNegativeIntegerSchema,
});
export type JobView = z.infer<typeof JobViewSchema>;

export const JobListViewSchema = z.strictObject({
  sessionId: z.string(),
  jobs: z.array(JobViewSchema),
  limits: z.strictObject({
    runningPerFerret: NonNegativeIntegerSchema,
    runningGlobal: NonNegativeIntegerSchema,
    running: NonNegativeIntegerSchema,
    retentionDays: NonNegativeIntegerSchema,
    retainedFinishedPerFerret: NonNegativeIntegerSchema,
  }),
});
export type JobListView = z.infer<typeof JobListViewSchema>;

/** `POST /v1/ferrets/:ferretId/jobs`. The CLI sends its own working directory. */
export const JobStartRequestSchema = z.strictObject({
  command: z.string().min(1).max(JOB_MAX_COMMAND_LENGTH),
  cwd: z.string().startsWith('/').optional(),
  name: JobNameSchema.optional(),
});
export type JobStartRequest = z.infer<typeof JobStartRequestSchema>;

/**
 * `GET …/jobs/:jobId/output?from=<byte offset>&tail=<lines>&attachment=<id>`: the log from `from` (or its last `tail`
 * lines), whole lines only until the job has ended. `next` is where to ask again; `detach` is the daemon asking this
 * attachment to let go (a move); `ended` is true once the job ended AND the log is read to its end.
 */
export const JobOutputViewSchema = z.strictObject({
  text: z.string(),
  next: NonNegativeIntegerSchema,
  size: NonNegativeIntegerSchema,
  job: JobViewSchema,
  ended: z.boolean(),
  detach: z.boolean(),
});
export type JobOutputView = z.infer<typeof JobOutputViewSchema>;

// ─── the registry's stored document ───────────────────────────────────────────────────────────────────────────────

export const AttachmentEntrySchema = z.strictObject({
  id: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(128),
  jobId: z.string().min(1).max(64),
  pid: z.number().int().positive(),
  /** The process's start as the host reported it when the entry was made (opaque; equal means the same process). */
  processStart: z.string().min(1).max(64),
  claudeTaskId: z.string().optional(),
  /**
   * The identity of the FILE the process ran when it registered (`dev:ino`, plus the script under a JavaScript runtime).
   * Absent on an entry an earlier daemon wrote: such an entry is never trusted as a kept attachment (fail closed).
   */
  executable: z.string().min(1).max(512).optional(),
  /**
   * The harness CLI that held the attachment when it registered (pid + start), when one did. If it is gone later the
   * attachment is an orphan — its harness was killed without a word — and the next sweep asks it to detach.
   */
  harness: z.strictObject({ pid: z.number().int().positive(), start: z.string().min(1).max(64) }).optional(),
  registeredAt: z.string(),
  detaching: z.boolean(),
});
export type AttachmentEntry = z.infer<typeof AttachmentEntrySchema>;

/** The kernel stamps `format` on write and strips it on read, so the schema holds only the entries. */
export const AttachmentsStateSchema = z.object({
  entries: z.array(AttachmentEntrySchema).default([]),
  /**
   * THE COMPLETION BACKSTOP'S ONE-TIME CUT-OVER (epoch ms): written the first time the backstop ever runs and never moved. A job
   * that ended before it is history (the hand-over and `fy job list` already show it); one that ended after it is news, however
   * many times the daemon restarted since. Absent until that first run.
   */
  backstopCutOverMs: z.number().int().nonnegative().optional(),
});
export type AttachmentsState = z.infer<typeof AttachmentsStateSchema>;

// ─── attachments ──────────────────────────────────────────────────────────────────────────────────────────────────

/** `POST …/job-attachments`: a live `fy job attach` announcing itself. */
export const JobAttachmentRegisterSchema = z.strictObject({
  jobId: z.string().min(1).max(64),
  pid: z.number().int().positive(),
  /** Claude Code's task id when the attachment's stdout is its `…/tasks/<id>.output` file. */
  claudeTaskId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/u)
    .optional(),
});
export type JobAttachmentRegister = z.infer<typeof JobAttachmentRegisterSchema>;

export const JobAttachmentViewSchema = z.strictObject({
  id: z.string(),
  sessionId: z.string(),
  jobId: z.string(),
  pid: z.number().int().positive(),
  claudeTaskId: z.string().optional(),
  registeredAt: InstantSchema,
  /** The daemon asked it to detach; it has not gone yet. */
  detaching: z.boolean(),
});
export type JobAttachmentView = z.infer<typeof JobAttachmentViewSchema>;

export const JobAttachmentListViewSchema = z.strictObject({
  sessionId: z.string(),
  attachments: z.array(JobAttachmentViewSchema),
});
export type JobAttachmentListView = z.infer<typeof JobAttachmentListViewSchema>;

export const JobDetachAllViewSchema = z.strictObject({ detached: NonNegativeIntegerSchema });

/**
 * The Claude Code task id a path names (`…/tasks/<id>.output`), or `undefined`. The rule lives in `@ferretry/std` — one
 * reading for the CLI, the Processes view and the move gate.
 */
export { claudeTaskId } from '@ferretry/std';
