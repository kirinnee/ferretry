import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

/**
 * A FERRET'S PROCESSES — every subprocess running under its own pane, and what each one is printing.
 *
 * Read from the operating system, never reported by the agent: the daemon walks the session's proved
 * pane (the one an attach proves, by pane id, pid and process start) and nothing else, so a process of
 * another ferret, or of the machine, can never appear here. The harness itself — the Claude or Codex CLI
 * the pane runs — is the root of the walk and is not listed: it is the Chat and the Console.
 *
 * Routes (all `terminal` / `use`, see docs/grants.md):
 * - `GET  /v1/sessions/:sessionId/processes` — {@link SessionProcessListSchema}
 * - `GET  /v1/sessions/:sessionId/processes/:processId/output?after=<byte>` — {@link SessionProcessOutputSchema}
 * - `POST /v1/sessions/:sessionId/processes/:processId/stop` — {@link SessionProcessStopResultSchema}
 */

/**
 * What a process is to the agent.
 *
 * - `command` — a tool command the agent is running right now and is waiting on.
 * - `background` — a tool command the agent started and did not wait for.
 * - `server` — a process holding a listening socket that a command left running (a dev server).
 * - `helper` — something the harness keeps for the whole session: an MCP server, a language server,
 *   Codex's app server, a browser an MCP server drives.
 */
export const SessionProcessKindSchema = z.enum(['command', 'background', 'server', 'helper']);
export type SessionProcessKind = z.infer<typeof SessionProcessKindSchema>;

/**
 * Where the process is in its life. `running` is on a CPU, `sleeping` is waiting on something (most
 * healthy processes, most of the time), `stopped` is suspended (Ctrl-Z, a debugger), `zombie` has exited
 * and its parent has not collected it, and `exited` is gone — kept for a while so its output can still
 * be read.
 */
export const SessionProcessStateSchema = z.enum(['running', 'sleeping', 'stopped', 'zombie', 'exited']);
export type SessionProcessState = z.infer<typeof SessionProcessStateSchema>;

/**
 * Where the process's output can be read from.
 *
 * - `file` — its standard output is a regular file (a Claude Code shell's own output file, or a
 *   redirect); the daemon reads that file, so the text is everything the process wrote.
 * - `transcript` — it has exited, and the conversation transcript recorded what the tool returned.
 * - `none` — nothing can be read without stealing it; `reason` says why in words a person can act on.
 */
export const SessionProcessOutputSourceSchema = z.enum(['file', 'transcript', 'none']);
export type SessionProcessOutputSource = z.infer<typeof SessionProcessOutputSourceSchema>;

export const SessionProcessOutputAvailabilitySchema = z.strictObject({
  source: SessionProcessOutputSourceSchema,
  /** Set when `source` is `none`: why there is nothing to read, e.g. "Writes to the terminal — see Console". */
  reason: z.string().min(1).max(200).optional(),
});
export type SessionProcessOutputAvailability = z.infer<typeof SessionProcessOutputAvailabilitySchema>;

/**
 * A process's identity: its pid and its start time (`ProcessIncarnation`: Linux start ticks, macOS epoch
 * seconds), joined by a dot. A pid the kernel hands to a later process carries a different start, so an
 * id never names two processes — Stop relies on that.
 */
export const SessionProcessIdSchema = z.string().regex(/^[1-9][0-9]{0,9}\.[0-9]{1,20}$/u);
export type SessionProcessId = z.infer<typeof SessionProcessIdSchema>;

/** The longest command line a list carries, in UTF-16 code units; a longer one is cut and says so. */
export const SESSION_PROCESS_COMMAND_MAX = 2_000;

/** How an exited process ended, when anything recorded it. */
export const SessionProcessExitSchema = z.strictObject({
  /** The exit code, when known. */
  code: z.number().int().optional(),
  /** `true` when it failed (a non-zero code, or the harness marked the result an error). */
  failed: z.boolean(),
});
export type SessionProcessExit = z.infer<typeof SessionProcessExitSchema>;

export const SessionProcessSchema = z.strictObject({
  id: SessionProcessIdSchema,
  pid: PositiveIntegerSchema,
  /** The process this one was started by, when that is listed too; absent for a top-level entry. */
  parentId: SessionProcessIdSchema.optional(),
  /**
   * The command line exactly as the kernel reports it (arguments joined by spaces), with any value of a
   * stored secret replaced by `‹secret:NAME›`. Cut to {@link SESSION_PROCESS_COMMAND_MAX}.
   */
  command: z.string().min(1).max(SESSION_PROCESS_COMMAND_MAX),
  commandTruncated: z.boolean(),
  /**
   * The command as the agent wrote it, when the harness wrapped it (Claude's `zsh -c … eval '<cmd>'`,
   * Codex's `bash -lc '<cmd>'`); absent when `command` already is what was asked for.
   */
  label: z.string().min(1).max(SESSION_PROCESS_COMMAND_MAX).optional(),
  kind: SessionProcessKindSchema,
  state: SessionProcessStateSchema,
  startedAt: InstantSchema,
  /** When the daemon first saw it gone; set exactly when `state` is `exited`. */
  endedAt: InstantSchema.optional(),
  exit: SessionProcessExitSchema.optional(),
  /** Share of one CPU since the last look, 0–100 per core (so above 100 on several cores). */
  cpuPercent: NonNegativeFiniteSchema.optional(),
  /** Resident memory. */
  rssBytes: NonNegativeIntegerSchema.optional(),
  output: SessionProcessOutputAvailabilitySchema,
  /** Whether Stop may be offered: a live process the daemon can still prove is this ferret's. */
  stoppable: z.boolean(),
});
export type SessionProcess = z.infer<typeof SessionProcessSchema>;

export const SessionProcessListSchema = z.strictObject({
  sessionId: z.string().min(1),
  observedAt: InstantSchema,
  /**
   * `false` when this host cannot list the pane's processes at all (the ferret is not running, or the
   * platform cannot be read); `reason` then says which, and `processes` is empty.
   */
  available: z.boolean(),
  reason: z.string().min(1).max(300).optional(),
  /** Parents before children; top-level entries oldest first. */
  processes: z.array(SessionProcessSchema).max(500),
});
export type SessionProcessList = z.infer<typeof SessionProcessListSchema>;

/** The most text one output read returns, in bytes: the tail of a larger file. */
export const SESSION_PROCESS_OUTPUT_READ_MAX = 256 * 1024;

/**
 * One read of a process's output.
 *
 * FOLLOWING. Ask with no `after` for the last {@link SESSION_PROCESS_OUTPUT_READ_MAX} bytes; then ask
 * with `after` set to the previous answer's `end` for whatever was written since. `start` is the byte
 * the text begins at: when it is past the `after` asked for, the gap was larger than one read and was
 * skipped (`skipped`), and when the file shrank below `after` (truncated, replaced) the read starts
 * again from the tail and `reset` says so.
 */
export const SessionProcessOutputSchema = z.strictObject({
  processId: SessionProcessIdSchema,
  source: SessionProcessOutputSourceSchema,
  reason: z.string().min(1).max(200).optional(),
  /** UTF-8 text, ANSI escapes kept, stored secret values replaced by `‹secret:NAME›`. */
  text: z.string(),
  start: NonNegativeIntegerSchema,
  end: NonNegativeIntegerSchema,
  /** The whole output's length at the time of the read. */
  size: NonNegativeIntegerSchema,
  /** Text before `start` exists and was not returned. */
  skipped: z.boolean(),
  /** The output was replaced or truncated since the `after` asked for; drop what you hold. */
  reset: z.boolean(),
  /** Nothing more will be written: the process has exited. */
  complete: z.boolean(),
});
export type SessionProcessOutput = z.infer<typeof SessionProcessOutputSchema>;

export const SessionProcessOutputQuerySchema = z.strictObject({
  after: z.coerce.number().int().nonnegative().optional(),
});

/**
 * Stopping one process: SIGTERM to it and every process below it, deepest first. The daemon first proves
 * again that the id's pid is still under this ferret's pane AND still has the same start time, so a pid
 * the kernel has since given to something else is never signalled.
 */
export const SessionProcessStopResultSchema = z.strictObject({
  processId: SessionProcessIdSchema,
  /** How many processes were sent SIGTERM (the process and its descendants). */
  signalled: NonNegativeIntegerSchema,
});
export type SessionProcessStopResult = z.infer<typeof SessionProcessStopResultSchema>;
