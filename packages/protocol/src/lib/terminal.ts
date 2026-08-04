import { z } from 'zod';
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
  'unavailable',
  'upstream_failed',
]);
export type TerminalErrorCode = z.infer<typeof TerminalErrorCodeSchema>;
