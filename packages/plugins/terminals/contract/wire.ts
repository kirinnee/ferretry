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

/** Limits the owner may lower below today's ceilings (never raise past them), so no edit loosens anything. */
export const TerminalsConfigSchema = z.strictObject({
  perFerret: z.number().int().min(1).max(TERMINAL_MAX_PER_SESSION).default(TERMINAL_MAX_PER_SESSION),
  global: z.number().int().min(1).max(TERMINAL_MAX_GLOBAL).default(TERMINAL_MAX_GLOBAL),
});
export type TerminalsConfig = z.infer<typeof TerminalsConfigSchema>;
