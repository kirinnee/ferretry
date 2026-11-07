import { z } from 'zod';
import { SurfaceNameSchema } from './agent-tools.ts';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';
import { SurfaceOpenerSchema } from './surface.ts';

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

export const TerminalSizeSchema = z.object({
  cols: z.number().int().min(TERMINAL_MIN_COLUMNS).max(TERMINAL_MAX_COLUMNS),
  rows: z.number().int().min(TERMINAL_MIN_ROWS).max(TERMINAL_MAX_ROWS),
});
export type TerminalSize = z.infer<typeof TerminalSizeSchema>;

export const TerminalViewSchema = z
  .object({
    id: TerminalIdSchema,
    sessionId: z.string().min(1),
    title: TerminalTitleSchema,
    /**
     * The terminal's human name — `dev` in `%terminal:dev` — shared by the person and the agent.
     * Unique within the session. ABSENT for a terminal opened without one, which is still addressable
     * by its id.
     */
    name: SurfaceNameSchema.optional(),
    state: z.literal('running'),
    cols: z.number().int().min(TERMINAL_MIN_COLUMNS).max(TERMINAL_MAX_COLUMNS),
    rows: z.number().int().min(TERMINAL_MIN_ROWS).max(TERMINAL_MAX_ROWS),
    viewers: NonNegativeIntegerSchema,
    /**
     * Who opened this shell, as the daemon can attest it. ABSENT MEANS
     * UNRECORDED — a terminal that predates provenance, or one served by a
     * daemon that never recorded it — and a reader is told that rather than
     * shown a guess. See `SurfaceOpenerSchema`.
     */
    openedBy: SurfaceOpenerSchema.optional(),
    createdAt: InstantSchema,
    lastActivityAt: InstantSchema,
    idleDeadline: InstantSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.viewers > 0 && value.idleDeadline !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'idleDeadline is valid only with no viewers',
        path: ['idleDeadline'],
      });
    }
    if (value.viewers === 0 && value.idleDeadline === undefined) {
      context.addIssue({ code: 'custom', message: 'idleDeadline is required with no viewers', path: ['idleDeadline'] });
    }
    if (Date.parse(value.lastActivityAt) < Date.parse(value.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'lastActivityAt may not precede createdAt',
        path: ['lastActivityAt'],
      });
    }
  });
export type TerminalView = z.infer<typeof TerminalViewSchema>;

export const TerminalListViewSchema = z
  .object({
    sessionId: z.string().min(1),
    terminals: z.array(TerminalViewSchema),
    limits: z.object({
      perSession: z.number().int().positive(),
      global: z.number().int().positive(),
      runningGlobal: NonNegativeIntegerSchema,
      idleTimeoutSeconds: z.number().int().positive(),
      scrollbackLines: z.number().int().positive(),
    }),
  })
  .superRefine((value, context) => {
    if (value.terminals.some(terminal => terminal.sessionId !== value.sessionId)) {
      context.addIssue({ code: 'custom', message: 'every terminal must belong to the listed session' });
    }
    if (value.terminals.length > value.limits.perSession) {
      context.addIssue({ code: 'custom', message: 'terminal count exceeds the per-session limit' });
    }
    if (value.limits.runningGlobal < value.terminals.length || value.limits.runningGlobal > value.limits.global) {
      context.addIssue({ code: 'custom', message: 'runningGlobal is inconsistent with terminal counts' });
    }
  });
export type TerminalListView = z.infer<typeof TerminalListViewSchema>;

export const CreateTerminalRequestSchema = z.strictObject({
  title: TerminalTitleSchema.optional(),
  /** A human name for the terminal, unique within the session — see `SurfaceNameSchema`. */
  name: SurfaceNameSchema.optional(),
  cols: z.number().int().min(TERMINAL_MIN_COLUMNS).max(TERMINAL_MAX_COLUMNS).optional(),
  rows: z.number().int().min(TERMINAL_MIN_ROWS).max(TERMINAL_MAX_ROWS).optional(),
  /**
   * The agent session this terminal is being opened FOR. It is the only part of
   * the opener a caller may state, and the daemon honours it only from a local
   * admin credential: a paired device is a human by construction, so letting one
   * name itself an agent would make `by: 'agent'` unreadable. The daemon derives
   * the rest of the opener from the credential — see `SurfaceOpenerSchema`.
   */
  agentSessionId: z.string().trim().min(1).max(128).optional(),
});
export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequestSchema>;

export const RenameTerminalRequestSchema = z.strictObject({
  title: TerminalTitleSchema,
});
export type RenameTerminalRequest = z.infer<typeof RenameTerminalRequestSchema>;

export const CloseTerminalResponseSchema = z.object({
  closed: z.literal(true),
  id: TerminalIdSchema,
});
export type CloseTerminalResponse = z.infer<typeof CloseTerminalResponseSchema>;

/**
 * WHO IS HOLDING THE TERMINALS, across every session on this machine.
 *
 * The daemon allows {@link TERMINAL_MAX_GLOBAL} shells at once, and a shell outlives nothing it should not:
 * the ones a COMPLETED or STOPPED ferret left behind used to fill the limit until nothing new could open.
 * `finished` is a holder whose session has ended (`completed`, `stopped`) and `gone` one whose session no
 * longer exists; both are reclaimable. `live` is everything else and is never touched.
 */
export const TERMINAL_HOLDER_STANDINGS = ['live', 'finished', 'gone'] as const;
export const TerminalHolderStandingSchema = z.enum(TERMINAL_HOLDER_STANDINGS);
export type TerminalHolderStanding = z.infer<typeof TerminalHolderStandingSchema>;

export const TerminalHolderSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  /** The ferret's callsign, else its name, else its id: what a person recognises it by. */
  label: z.string().min(1).max(128),
  standing: TerminalHolderStandingSchema,
  /** The session's status word, or `removed` when the session is gone. */
  status: z.string().min(1).max(32),
  count: NonNegativeIntegerSchema,
});
export type TerminalHolder = z.infer<typeof TerminalHolderSchema>;

export const TerminalHoldersViewSchema = z.strictObject({
  /** The most terminals the daemon allows at once. */
  limit: NonNegativeIntegerSchema,
  /** How many are open now. */
  open: NonNegativeIntegerSchema,
  /** Largest holder first. */
  holders: z.array(TerminalHolderSchema),
});
export type TerminalHoldersView = z.infer<typeof TerminalHoldersViewSchema>;

export const CloseFinishedTerminalsResponseSchema = z.strictObject({
  /** How many terminals were closed. */
  closed: NonNegativeIntegerSchema,
  /** How many a finished session still holds because tmux refused to end them. */
  failed: NonNegativeIntegerSchema,
  /** What was closed, by holder. */
  holders: z.array(TerminalHolderSchema),
});
export type CloseFinishedTerminalsResponse = z.infer<typeof CloseFinishedTerminalsResponseSchema>;

/** JSON control frame; raw terminal input and output use Uint8Array frames. */
export const TerminalResizeFrameSchema = z.strictObject({
  type: z.literal('resize'),
  cols: z.number().int().min(TERMINAL_MIN_COLUMNS).max(TERMINAL_MAX_COLUMNS),
  rows: z.number().int().min(TERMINAL_MIN_ROWS).max(TERMINAL_MAX_ROWS),
});
export type TerminalResizeFrame = z.infer<typeof TerminalResizeFrameSchema>;

export const TerminalBinaryFrameSchema = z.instanceof(Uint8Array);
export type TerminalBinaryFrame = z.infer<typeof TerminalBinaryFrameSchema>;

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
