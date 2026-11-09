/**
 * Terminals' wire (§2.1), copied field for field from today's `packages/protocol/src/lib/{terminal,surface,
 * surface-names}.ts` and the terminal calls of `agent-tools.ts`. A terminal's TEXT never appears in a view here:
 * it leaves only through `Redaction.read` and the final check (§7.3).
 */
import { InstantSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';

// ─── surfaces (a terminal or a page, by name or id) ───────────────────────────────────────────────────────────────

export const SURFACE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const TERMINAL_ID_SHAPE = /^[a-f0-9]{12}$/u;

export const SurfaceNameSchema = z
  .string()
  .regex(SURFACE_NAME_PATTERN, 'a name is a lowercase letter, then up to 31 lowercase letters, digits or dashes')
  .refine(value => !TERMINAL_ID_SHAPE.test(value), 'a name may not look like a terminal id (twelve hex characters)');
export type SurfaceName = z.infer<typeof SurfaceNameSchema>;

/** A terminal's name or id; a `%terminal:` reference prefix is read through (`docs/reference-standard.md`). */
export const SurfaceKeySchema = z
  .string()
  .trim()
  .transform(value => value.replace(/^%(?:terminal|browser):/u, ''))
  .pipe(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u, 'not a surface name or id'));

const OpaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}\p{Cf}\s]+$/u);

/** Who opened a surface: a paired device, a ferret, or somebody at this machine. */
export const SurfaceOpenerSchema = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('human'), deviceId: OpaqueIdSchema }),
  z.strictObject({ by: z.literal('agent'), sessionId: OpaqueIdSchema }),
  z.strictObject({ by: z.literal('local') }),
]);
export type SurfaceOpener = z.infer<typeof SurfaceOpenerSchema>;

/** `POST /v1/sessions/:sessionId/surfaces/terminals/control`: take over, hand back, or hand to the ferret. */
export const SurfaceControlRequestSchema = z.strictObject({
  action: z.enum(['takeover', 'handback', 'handover']),
  key: SurfaceKeySchema,
});
export type SurfaceControlRequest = z.infer<typeof SurfaceControlRequestSchema>;

// ─── terminals ────────────────────────────────────────────────────────────────────────────────────────────────────

export const TERMINAL_MAX_PER_SESSION = 6;
export const TERMINAL_MAX_GLOBAL = 24;
export const TERMINAL_SCROLLBACK_LINES = 5_000;
export const TERMINAL_MIN_COLUMNS = 20;
export const TERMINAL_MAX_COLUMNS = 300;
export const TERMINAL_MIN_ROWS = 5;
export const TERMINAL_MAX_ROWS = 120;
export const TERMINAL_MAX_TITLE_LENGTH = 64;

const TerminalTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(TERMINAL_MAX_TITLE_LENGTH)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u);

export const TerminalIdSchema = z.string().regex(/^[a-f0-9]{12}$/u);
export type TerminalId = z.infer<typeof TerminalIdSchema>;

const ColumnsSchema = z.number().int().min(TERMINAL_MIN_COLUMNS).max(TERMINAL_MAX_COLUMNS);
const RowsSchema = z.number().int().min(TERMINAL_MIN_ROWS).max(TERMINAL_MAX_ROWS);

export const TerminalSizeSchema = z.strictObject({ cols: ColumnsSchema, rows: RowsSchema });
export type TerminalSize = z.infer<typeof TerminalSizeSchema>;

/** One terminal, as a viewer lists it. `title` is set by programs in the pane, so the route guard is `secrets`. */
export const TerminalViewSchema = z
  .strictObject({
    id: TerminalIdSchema,
    sessionId: z.string().min(1),
    title: TerminalTitleSchema,
    name: SurfaceNameSchema.optional(),
    state: z.literal('running'),
    cols: ColumnsSchema,
    rows: RowsSchema,
    viewers: NonNegativeIntegerSchema,
    openedBy: SurfaceOpenerSchema.optional(),
    createdAt: InstantSchema,
    lastActivityAt: InstantSchema,
    idleDeadline: InstantSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.viewers > 0 && value.idleDeadline !== undefined)
      context.addIssue({
        code: 'custom',
        message: 'idleDeadline is valid only with no viewers',
        path: ['idleDeadline'],
      });
    if (value.viewers === 0 && value.idleDeadline === undefined)
      context.addIssue({ code: 'custom', message: 'idleDeadline is required with no viewers', path: ['idleDeadline'] });
    if (Date.parse(value.lastActivityAt) < Date.parse(value.createdAt))
      context.addIssue({
        code: 'custom',
        message: 'lastActivityAt may not precede createdAt',
        path: ['lastActivityAt'],
      });
  });
export type TerminalView = z.infer<typeof TerminalViewSchema>;

export const TerminalListViewSchema = z
  .strictObject({
    sessionId: z.string().min(1),
    terminals: z.array(TerminalViewSchema),
    limits: z.strictObject({
      perSession: z.number().int().positive(),
      global: z.number().int().positive(),
      runningGlobal: NonNegativeIntegerSchema,
      idleTimeoutSeconds: z.number().int().positive(),
      scrollbackLines: z.number().int().positive(),
    }),
  })
  .superRefine((value, context) => {
    if (value.terminals.some(terminal => terminal.sessionId !== value.sessionId))
      context.addIssue({ code: 'custom', message: 'every terminal must belong to the listed session' });
    if (value.terminals.length > value.limits.perSession)
      context.addIssue({ code: 'custom', message: 'terminal count exceeds the per-session limit' });
    if (value.limits.runningGlobal < value.terminals.length || value.limits.runningGlobal > value.limits.global)
      context.addIssue({ code: 'custom', message: 'runningGlobal is inconsistent with terminal counts' });
  });
export type TerminalListView = z.infer<typeof TerminalListViewSchema>;

export const CreateTerminalRequestSchema = z.strictObject({
  title: TerminalTitleSchema.optional(),
  name: SurfaceNameSchema.optional(),
  cols: ColumnsSchema.optional(),
  rows: RowsSchema.optional(),
  agentSessionId: z.string().trim().min(1).max(128).optional(),
});
export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequestSchema>;

export const RenameTerminalRequestSchema = z.strictObject({ title: TerminalTitleSchema });
export type RenameTerminalRequest = z.infer<typeof RenameTerminalRequestSchema>;

export const CloseTerminalResponseSchema = z.strictObject({ closed: z.literal(true), id: TerminalIdSchema });
export type CloseTerminalResponse = z.infer<typeof CloseTerminalResponseSchema>;

export const TerminalHolderStandingSchema = z.enum(['live', 'finished', 'gone']);
export const TerminalHolderSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  standing: TerminalHolderStandingSchema,
  status: z.string().min(1).max(32),
  count: NonNegativeIntegerSchema,
});
export type TerminalHolder = z.infer<typeof TerminalHolderSchema>;

/** `GET /v1/terminals`: who holds terminals across the machine. */
export const TerminalHoldersViewSchema = z.strictObject({
  limit: NonNegativeIntegerSchema,
  open: NonNegativeIntegerSchema,
  holders: z.array(TerminalHolderSchema),
});
export type TerminalHoldersView = z.infer<typeof TerminalHoldersViewSchema>;

export const CloseFinishedTerminalsResponseSchema = z.strictObject({
  closed: NonNegativeIntegerSchema,
  failed: NonNegativeIntegerSchema,
  holders: z.array(TerminalHolderSchema),
});
export type CloseFinishedTerminalsResponse = z.infer<typeof CloseFinishedTerminalsResponseSchema>;

/** The viewer stream's one control frame; everything else on it is masked binary output. */
export const TerminalResizeFrameSchema = z.strictObject({
  type: z.literal('resize'),
  cols: ColumnsSchema,
  rows: RowsSchema,
});
export type TerminalResizeFrame = z.infer<typeof TerminalResizeFrameSchema>;

export const TerminalErrorCodeSchema = z.enum([
  'bad_request',
  'not_found',
  'forbidden',
  'capacity',
  'conflict',
  'unavailable',
  'upstream_failed',
]);
export type TerminalErrorCode = z.infer<typeof TerminalErrorCodeSchema>;

// ─── agent tools (MCP) ────────────────────────────────────────────────────────────────────────────────────────────

export const AGENT_TOOL_MAX_TEXT_CHARS = 16_384;
export const AGENT_TOOL_MAX_KEYS = 64;
export const AGENT_TOOL_DEFAULT_READ_LINES = 200;
export const AGENT_TOOL_MAX_READ_LINES = 2_000;
export const AGENT_TOOL_MAX_WAIT_MS = 25_000;
export const AGENT_TOOL_DEFAULT_WAIT_MS = 10_000;
export const AGENT_TOOL_MAX_FOLDER_CHARS = 1_024;
export const AGENT_TOOL_MAX_ASK_CHARS = 280;

export const TERMINAL_KEYS = [
  'enter',
  'tab',
  'escape',
  'backspace',
  'delete',
  'space',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'page-up',
  'page-down',
  'ctrl-a',
  'ctrl-c',
  'ctrl-d',
  'ctrl-e',
  'ctrl-k',
  'ctrl-l',
  'ctrl-r',
  'ctrl-u',
  'ctrl-w',
  'ctrl-z',
] as const;
export const TerminalKeySchema = z.enum(TERMINAL_KEYS);
export type TerminalKey = z.infer<typeof TerminalKeySchema>;

const TextSchema = z.string().min(1).max(AGENT_TOOL_MAX_TEXT_CHARS);
export const AskOwnerMessageSchema = z.string().trim().min(1).max(AGENT_TOOL_MAX_ASK_CHARS);

export const TerminalListInputSchema = z.strictObject({});
export const TerminalOpenInputSchema = z.strictObject({
  name: SurfaceNameSchema,
  folder: z.string().trim().min(1).max(AGENT_TOOL_MAX_FOLDER_CHARS).optional(),
  command: TextSchema.optional(),
  askOwner: z.union([z.literal(true), AskOwnerMessageSchema]).optional(),
});
export const TerminalSendInputSchema = z
  .strictObject({
    name: SurfaceKeySchema,
    text: TextSchema.optional(),
    keys: z.array(TerminalKeySchema).min(1).max(AGENT_TOOL_MAX_KEYS).optional(),
  })
  .refine(call => call.text !== undefined || call.keys !== undefined, 'send needs text, keys, or both');
export const TerminalReadInputSchema = z.strictObject({
  name: SurfaceKeySchema,
  lines: z.number().int().min(1).max(AGENT_TOOL_MAX_READ_LINES).optional(),
});
export const TerminalWaitInputSchema = z
  .strictObject({
    name: SurfaceKeySchema,
    text: z.string().min(1).max(1_024).optional(),
    exit: z.literal(true).optional(),
    timeoutMs: z.number().int().min(100).max(AGENT_TOOL_MAX_WAIT_MS).optional(),
  })
  .refine(call => (call.text === undefined) !== (call.exit === undefined), 'wait for text or for exit, not both');
export const TerminalCloseInputSchema = z.strictObject({ name: SurfaceKeySchema });
export const TerminalAskOwnerInputSchema = z.strictObject({
  name: SurfaceKeySchema,
  message: AskOwnerMessageSchema.optional(),
});

// ─── config/terminals.yaml ────────────────────────────────────────────────────────────────────────────────────────

/** The most bytes one terminal environment value may hold. */
export const TERMINAL_ENVIRONMENT_VALUE_MAX_BYTES = 4_096;

/** A variable name a terminal environment may carry: capitals, digits and underscores, not starting with a digit. */
const TERMINAL_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;

/**
 * Names a terminal environment never sets: the kernel gives every child its own `PATH` and `HOME`, the login shell
 * picks `SHELL`, and the three below are the ferret identity names the daemon forgets (a terminal must never be handed
 * a ferret's credential). `LD_*` and `DYLD_*` (any program loaded afterwards) are refused by prefix.
 */
const TERMINAL_ENVIRONMENT_REFUSED: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'FY_SESSION_TOKEN',
  'FY_SESSION_BOARD_CAPABILITY',
  'FY_SESSION_ID',
]);

/** Why a terminal environment name is refused, in a sentence that names it; `undefined` when it is fine. */
export function terminalEnvironmentNameProblem(name: string): string | undefined {
  if (!TERMINAL_ENVIRONMENT_NAME.test(name))
    return `"${name.slice(0, 64)}" is not a usable variable name: use capital letters, digits and underscores, and do not start with a digit`;
  if (name.startsWith('LD_') || name.startsWith('DYLD_'))
    return `${name} is refused: it changes which programs and libraries every command loads`;
  if (TERMINAL_ENVIRONMENT_REFUSED.has(name))
    return `${name} is refused: the daemon, the kernel or the login shell sets it, or it names a ferret's own identity`;
  return undefined;
}

/** Why a terminal environment value is refused, in a sentence that names its variable; `undefined` when it is fine. */
export function terminalEnvironmentValueProblem(name: string, value: string): string | undefined {
  if (value.includes('${secret:'))
    return `${name} names a secret: a secret reaches a command only through the secret store, never through a terminal environment`;
  if (value.includes('\0')) return `${name} holds a NUL character`;
  if (new TextEncoder().encode(value).length > TERMINAL_ENVIRONMENT_VALUE_MAX_BYTES)
    return `${name} is longer than ${String(TERMINAL_ENVIRONMENT_VALUE_MAX_BYTES)} bytes`;
  return undefined;
}

/** `environment: { NAME: value }`: each problem is its own issue, located at the variable. */
const TerminalEnvironmentSchema = z.record(z.string(), z.string()).superRefine((environment, context) => {
  for (const [name, value] of Object.entries(environment)) {
    const problem = terminalEnvironmentNameProblem(name) ?? terminalEnvironmentValueProblem(name, value);
    if (problem !== undefined) context.addIssue({ code: 'custom', message: problem, path: [name] });
  }
});

/**
 * Limits the owner may lower below today's ceilings (never raise past them), and the environment every terminal is
 * opened with (the owner's own and a ferret's alike). The environment is OWNER-ONLY: any change to it waits for the
 * owner ({@link terminalsLoosens}).
 */
export const TerminalsConfigSchema = z.strictObject({
  perFerret: z.number().int().min(1).max(TERMINAL_MAX_PER_SESSION).default(TERMINAL_MAX_PER_SESSION),
  global: z.number().int().min(1).max(TERMINAL_MAX_GLOBAL).default(TERMINAL_MAX_GLOBAL),
  environment: TerminalEnvironmentSchema.optional(),
});
export type TerminalsConfig = z.infer<typeof TerminalsConfigSchema>;

/**
 * An environment variable a terminal opens with is authority (it can put any program first on a command's path): any
 * variable added, changed or removed waits for the owner, whoever wrote it. The caps and the rest loosen nothing.
 * Judges a deletion too (`after` is `undefined` or the defaults).
 */
export function terminalsLoosens(
  before: TerminalsConfig | undefined,
  after: TerminalsConfig | undefined,
): readonly string[] {
  const was = before?.environment ?? {};
  const now = after?.environment ?? {};
  return [...new Set([...Object.keys(was), ...Object.keys(now)])]
    .sort()
    .filter(name => was[name] !== now[name])
    .map(name =>
      was[name] === undefined
        ? `every terminal will open with ${name} set`
        : now[name] === undefined
          ? `terminals will stop opening with ${name} set`
          : `every terminal will open with a different ${name}`,
    );
}

// ─── state/terminals/terminals.json (format 1) ────────────────────────────────────────────────────────────────────

/** A tmux pane id as tmux prints one (`%12`). It is the `tmux` runner's handle. */
export const PaneIdSchema = z.string().regex(/^%(?:0|[1-9][0-9]*)$/u, 'a pane id is % then a number');

/**
 * One ferret's pane, as today's durable terminal pane registration recorded it (`DurableTerminalPaneRegistrar`), less
 * the `daemonId`/`sessionId` it was filed under: here it is keyed by the ferret, inside this daemon's own state. A pid
 * is not an identity, so the whole incarnation is kept — pane, pid and its start ticks — and every reader proves the
 * whole tuple again before acting on it.
 */
export const RegisteredPaneSchema = z.strictObject({
  tmuxSession: z.string().min(1),
  paneId: PaneIdSchema,
  pid: z.number().int().positive(),
  processStartTicks: NonNegativeIntegerSchema,
  /** tmux's `session_created`, in epoch seconds, when it was known. */
  sessionCreated: z.number().int().positive().optional(),
});
export type RegisteredPane = z.infer<typeof RegisteredPaneSchema>;

/** One terminal surface control change (`surface.*`), as today's session journal carried it; parsed again on replay. */
export const RecordedSurfaceEventSchema = z.object({ type: z.string().min(1), data: z.unknown() });

/** How many control changes are kept per ferret: the newest decide. */
export const SURFACE_EVENTS_KEPT_PER_FERRET = 256;

/**
 * Terminals' state document. The terminals themselves are NOT here: as today, each terminal's registry lives on its
 * own tmux session (`@fy_terminal_*` options), so it is exactly as live as the session. This holds what tmux does not:
 * each ferret's registered pane (the processes, console and attach proofs, and limits) and the control history.
 */
export const TerminalsStateSchema = z.object({
  panes: z.record(z.string().min(1), RegisteredPaneSchema).default({}),
  events: z
    .record(z.string().min(1), z.array(RecordedSurfaceEventSchema).max(SURFACE_EVENTS_KEPT_PER_FERRET))
    .default({}),
});
export type TerminalsState = z.infer<typeof TerminalsStateSchema>;
