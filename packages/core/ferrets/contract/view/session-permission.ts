import { z } from 'zod';
import { HarnessSchema } from './session-base.ts';

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
export const PermissionOptionKindSchema = z.enum([
  /** Run this one call ("Yes", "Yes, proceed"). */
  'allow',
  /** Allow it and more like it — "don't ask again for …", "allow all edits during this session". */
  'allow-always',
  /** Refuse ("No", "No, and tell Claude what to do differently"). */
  'deny',
]);
export type PermissionOptionKind = z.infer<typeof PermissionOptionKindSchema>;

export const PermissionOptionSchema = z.strictObject({
  /** The digit the harness drew beside it, and the key that picks it. */
  number: z.number().int().min(1).max(9),
  /** The choice in the harness's own words, without its keyboard hint (`(y)`, `(shift+tab)`, `(esc)`). */
  label: z.string().min(1).max(300),
  kind: PermissionOptionKindSchema,
});
export type PermissionOption = z.infer<typeof PermissionOptionSchema>;

/** What the agent is asking to do, in one verb a sentence can be built on. */
export const PermissionActionSchema = z.enum(['run', 'read', 'edit', 'create', 'fetch', 'use', 'exit-plan', 'other']);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

/** The prompt's identity: a digest of everything a person decides on, so a changed prompt is a new id. */
export const PermissionRequestIdSchema = z.string().regex(/^[0-9a-f]{16}$/u);

export const PermissionRequestSchema = z
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

/**
 * One answer. `choice` picks a numbered option; `deny` refuses the way the harness's own `(esc)` does,
 * which leaves the agent at its prompt — a `note` for it is then sent as an ordinary message.
 */
export const PermissionAnswerRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('choice'),
    requestId: PermissionRequestIdSchema,
    number: z.number().int().min(1).max(9),
  }),
  z.strictObject({ kind: z.literal('deny'), requestId: PermissionRequestIdSchema }),
]);
export type PermissionAnswerRequest = z.infer<typeof PermissionAnswerRequestSchema>;

/**
 * What answering did. `cleared` is the pane's own word, read after the keys landed: the prompt the
 * person answered is no longer on screen. `false` means the keys were sent and the same prompt is still
 * up — say so; never send them again.
 */
export const PermissionAnswerResultSchema = z.strictObject({
  requestId: PermissionRequestIdSchema,
  cleared: z.boolean(),
});
export type PermissionAnswerResult = z.infer<typeof PermissionAnswerResultSchema>;
