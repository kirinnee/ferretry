import { z } from 'zod';

/** Timestamps on the ferret's own record stay ISO text; the typed instants are the contract's. */
const InstantSchema = z.string().min(1);
type Instant = string;

const SessionStatusSchema = z.enum([
  'created',
  'starting',
  'running',
  'thinking',
  'tool_running',
  'awaiting_question',
  'awaiting_user',
  'interrupted',
  'rate_limited',
  'retrying',
  'kill_failed',
  'waiting',
  'completed',
  'failed',
  'stalled',
  'stopped',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
/**
 * WHOSE TURN IT IS in a live session — the one fact the spinner, the status dots and the
 * notifications all read.
 *
 * `status` cannot answer it: `running` means the agent's terminal is live, and nothing moved it off
 * `running` when a turn ended. The daemon's turn watcher owns this field and derives it from the
 * harness's own evidence — its transcript's turn boundaries and the live pane (its spinner line, an
 * idle prompt, a permission prompt) — never from "a message was sent".
 *
 *   * `working` — the agent is mid-turn.
 *   * `your-turn` — the agent is idle at its prompt, waiting for the next message.
 *   * `needs-input` — the agent is blocked on a person: a permission prompt or a question.
 *
 * Absent for a session that is not live (not launched yet, or finished), and from a daemon that
 * predates the watcher.
 */
const SessionTurnStateSchema = z.enum(['working', 'your-turn', 'needs-input']);
export type SessionTurnState = z.infer<typeof SessionTurnStateSchema>;
const SessionHealthSchema = z.enum([
  'healthy',
  'thinking',
  'waiting',
  'idle',
  'stalled',
  'rate_limited',
  'crashed',
  'unknown',
]);
export type SessionHealth = z.infer<typeof SessionHealthSchema>;
const PendingQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
const PendingQuestionSchema = z.object({
  toolUseId: z.string().min(1),
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().optional(),
        options: z.array(PendingQuestionOptionSchema).optional(),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1),
  askedAt: InstantSchema.optional(),
  lastSeenAt: InstantSchema.optional(),
  missingSince: InstantSchema.optional(),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;
const InteractionModeSchema = z.enum(['auto', 'interactive']);
export type InteractionMode = z.infer<typeof InteractionModeSchema>;
/** The dialog's identity: a digest of everything a person decides on, so a changed dialog is a new id. */
const HarnessDialogIdSchema = z.string().regex(/^[0-9a-f]{16}$/u);
/** Harness family shared by session records and transfer lineage leaves. */
const HarnessSchema = z.enum(['claude', 'codex']);
/**
 * A HARNESS DIALOG, read off the agent's own pane.
 *
 * Besides tool permissions (`./session-permission.ts`), Claude Code and Codex stop on screens of their
 * own: Codex's "Hooks need review" and "Update available", its sign-in screen, Claude's "New MCP server
 * found in this project" and "Settings Error". Each is a choice list with a key-hint footer
 * ("enter confirm · esc skip"), and nothing moves until somebody answers it — so a session nobody is
 * watching sits there, and before this nothing outside the Console said so.
 *
 * Read from the pane, never invented: every option is a row the harness drew, in its order, and
 * `escape` is there only when the footer offers Esc. The daemon never answers one that grants trust —
 * a person does, through `POST /v1/sessions/:sessionId/dialog`, and only while the pane still shows the
 * very dialog they saw (`id`). docs/harness-dialogs.md lists which harmless ones are dismissed for them.
 */

/** Which dialog it is. `other` is any screen of the same shape this list does not name. */
const HarnessDialogKindSchema = z.enum([
  /** Codex: hooks it has not been told to trust ("1 hook is new or changed"). */
  'hooks-review',
  /** Codex: the hook list "Review hooks" opens. Esc closes it and the session goes on. */
  'hooks-list',
  /** Codex: "Update available". */
  'update',
  /** Codex: the sign-in screen of a home with no login. */
  'sign-in',
  /** Claude: a project `.mcp.json` names servers nobody has approved. */
  'mcp-servers',
  /** Claude: a settings file it could not use. */
  'settings-error',
  /** Either: "Do you trust this folder?". */
  'directory-trust',
  /** Claude: `/rate-limit-options` after "You've hit your … limit" — the login is out of spend or usage. */
  'usage-limit',
  'other',
]);
const HarnessDialogOptionSchema = z.strictObject({
  /** Its position in the list, from 1 — the harness's own digit where it draws one. */
  number: z.number().int().min(1).max(9),
  /** The choice in the harness's own words. */
  label: z.string().min(1).max(300),
  /** The line the harness prints under it, when it prints one ("Pay for what you use"). */
  detail: z.string().min(1).max(300).optional(),
  /** Choosing it trusts something to run — hooks, an MCP server, a folder. Never chosen by the daemon. */
  grantsTrust: z.boolean(),
});
const HarnessDialogSchema = z
  .strictObject({
    id: HarnessDialogIdSchema,
    harness: HarnessSchema,
    kind: HarnessDialogKindSchema,
    /** The dialog's own title or first line. */
    title: z.string().min(1).max(300),
    /** What it says between the title and the choices, line by line. */
    body: z.string().min(1).max(1200).optional(),
    options: z.array(HarnessDialogOptionSchema).max(9),
    /** The row the harness's cursor is on — what Enter alone would pick. Absent when there are no rows. */
    selected: z.number().int().min(1).max(9).optional(),
    /** The footer's word for Esc ("skip", "cancel", "go back", "close"), when it offers Esc. */
    escape: z.string().min(1).max(60).optional(),
  })
  .refine(dialog => dialog.options.every((option, index) => option.number === index + 1), {
    message: 'options are numbered 1..n in order',
  })
  .refine(dialog => (dialog.selected === undefined) === (dialog.options.length === 0), {
    message: 'a dialog with options has a selection, and only then',
  })
  .refine(dialog => dialog.selected === undefined || dialog.selected <= dialog.options.length, {
    message: 'the selection is one of the options',
  })
  .refine(dialog => dialog.options.length > 0 || dialog.escape !== undefined, {
    message: 'a dialog offers a way out: an option or Esc',
  });
export type HarnessDialog = z.infer<typeof HarnessDialogSchema>;
/** The prompt's identity: a digest of everything a person decides on, so a changed prompt is a new id. */
const PermissionRequestIdSchema = z.string().regex(/^[0-9a-f]{16}$/u);
/** What the agent is asking to do, in one verb a sentence can be built on. */
const PermissionActionSchema = z.enum(['run', 'read', 'edit', 'create', 'fetch', 'use', 'exit-plan', 'other']);
/**
 * A HARNESS PERMISSION PROMPT, read off the agent's own pane.
 *
 * Claude Code and Codex both stop before a tool they have not been allowed to run and draw a numbered
 * choice list in their terminal — "Do you want to proceed? 1. Yes 2. Yes, and don't ask again for … 3.
 * No". Nothing moves until somebody picks one, and nothing else in the conversation says so. This is that
 * prompt as data: what the agent wants to do, and the exact choices the harness offered.
 *
 * Read from the pane, never invented: every option is a row the harness drew, numbered as it numbered
 * it. The daemon never answers one on its own — a person does, through
 * `POST /v1/sessions/:sessionId/permission`, and only while the pane still shows the very prompt they
 * saw (`id`).
 */

/** What a choice does, as far as its own words say. The words themselves are `label`. */
const PermissionOptionKindSchema = z.enum([
  /** Run this one call ("Yes", "Yes, proceed"). */
  'allow',
  /** Allow it and more like it — "don't ask again for …", "allow all edits during this session". */
  'allow-always',
  /** Refuse ("No", "No, and tell Claude what to do differently"). */
  'deny',
]);
const PermissionOptionSchema = z.strictObject({
  /** The digit the harness drew beside it, and the key that picks it. */
  number: z.number().int().min(1).max(9),
  /** The choice in the harness's own words, without its keyboard hint (`(y)`, `(shift+tab)`, `(esc)`). */
  label: z.string().min(1).max(300),
  kind: PermissionOptionKindSchema,
});
const PermissionRequestSchema = z
  .strictObject({
    id: PermissionRequestIdSchema,
    harness: HarnessSchema,
    /** The harness's own name for the tool: `Bash`, `Read`, `Edit`, `Write`, `WebFetch`, an MCP tool… */
    tool: z.string().min(1).max(120),
    action: PermissionActionSchema,
    /** The command, path, URL or MCP call the prompt is about, when it names one. */
    what: z.string().min(1).max(500).optional(),
    /** The harness's explanation beside it — a command's description, Codex's `Reason:`. */
    detail: z.string().min(1).max(300).optional(),
    /** The question as the pane asks it. */
    question: z.string().min(1).max(300),
    options: z.array(PermissionOptionSchema).min(2).max(9),
    /** The `number` of the option the harness's cursor is on — what Enter alone would pick. */
    selected: z.number().int().min(1).max(9),
  })
  .refine(request => request.options.every((option, index) => option.number === index + 1), {
    message: 'options are numbered 1..n in order',
  })
  .refine(request => request.selected <= request.options.length, { message: 'the selection is one of the options' });
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;
export const AgendaIdSchema = z.string().regex(/^A[1-9][0-9]*$/u);
export type AgendaId = z.infer<typeof AgendaIdSchema>;
const AccountAvailabilitySchema = z.enum(['available', 'unavailable']);
const AccountUnavailableReasonSchema = z.enum(['cooldown', 'spend_limit', 'auth', 'provider', 'no_credentials']);
const NonNegativeFiniteSchema = z.number().finite().nonnegative();
const QuotaSchema = z.object({
  usageBased: z.boolean().optional(),
  availability: AccountAvailabilitySchema.optional(),
  unavailable: z.boolean().optional(),
  unavailableReason: AccountUnavailableReasonSchema.optional(),
  retryAt: NonNegativeFiniteSchema.optional(),
  atLimit: z.boolean().optional(),
  authOk: z.boolean().optional(),
  provider: z.string().optional(),
  fiveHourPercent: z.number().finite().min(0).max(100).optional(),
  weeklyPercent: z.number().finite().min(0).max(100).optional(),
  fiveHourResetAt: NonNegativeFiniteSchema.optional(),
  weeklyResetAt: NonNegativeFiniteSchema.optional(),
  resetAt: NonNegativeFiniteSchema.optional(),
  /** The harness's own words for the limit Ferretry read this session as `rate_limited` on (a pane dialog or a
   *  transcript record) — present exactly while that reading holds. */
  limitNotice: z.string().min(1).optional(),
});

/**
 * What a ferret's record says that the send, question and turn code reads and writes (the fields of today's session
 * state it uses; everything else on the record is Ferrets'). Optional where the record leaves it out.
 */
export type SessionState = {
  readonly id: string;
  readonly status: SessionStatus;
  readonly turn: number;
  readonly health?: SessionHealth | undefined;
  readonly pendingQuestion?: PendingQuestion | null | undefined;
  readonly lastAnsweredQuestionToolUseId?: string | undefined;
  readonly needsHuman?: string | undefined;
  readonly needsHumanKind?: string | undefined;
  readonly reason?: string | undefined;
  readonly quota?: Quota | undefined;
  readonly turnState?: SessionTurnState | undefined;
  readonly turnStateAt?: Instant | undefined;
  readonly turnPrompt?: string | undefined;
  readonly permissionRequest?: PermissionRequest | undefined;
  readonly harnessDialog?: HarnessDialog | undefined;
};

/** What a changed ferret answers to the caller of a write: its record, as the owning plugin shows it. */
export type SessionView = SessionState & { readonly [field: string]: unknown };
type Quota = z.infer<typeof QuotaSchema>;
