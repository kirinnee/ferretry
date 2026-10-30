import { z } from 'zod';
import { HarnessSchema } from './session-base.ts';

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
export const HarnessDialogKindSchema = z.enum([
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
export type HarnessDialogKind = z.infer<typeof HarnessDialogKindSchema>;

export const HarnessDialogOptionSchema = z.strictObject({
  /** Its position in the list, from 1 — the harness's own digit where it draws one. */
  number: z.number().int().min(1).max(9),
  /** The choice in the harness's own words. */
  label: z.string().min(1).max(300),
  /** The line the harness prints under it, when it prints one ("Pay for what you use"). */
  detail: z.string().min(1).max(300).optional(),
  /** Choosing it trusts something to run — hooks, an MCP server, a folder. Never chosen by the daemon. */
  grantsTrust: z.boolean(),
});
export type HarnessDialogOption = z.infer<typeof HarnessDialogOptionSchema>;

/** The dialog's identity: a digest of everything a person decides on, so a changed dialog is a new id. */
export const HarnessDialogIdSchema = z.string().regex(/^[0-9a-f]{16}$/u);

export const HarnessDialogSchema = z
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

/** One answer: pick a numbered option, or press the Esc the footer offers. */
export const HarnessDialogAnswerRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('choice'),
    dialogId: HarnessDialogIdSchema,
    number: z.number().int().min(1).max(9),
  }),
  z.strictObject({ kind: z.literal('escape'), dialogId: HarnessDialogIdSchema }),
]);
export type HarnessDialogAnswerRequest = z.infer<typeof HarnessDialogAnswerRequestSchema>;

/**
 * What answering did. `cleared` is the pane's own word, read after the keys landed: the dialog the
 * person answered is no longer on screen. `false` means it is still up — say so; never send again.
 */
export const HarnessDialogAnswerResultSchema = z.strictObject({
  dialogId: HarnessDialogIdSchema,
  cleared: z.boolean(),
});
export type HarnessDialogAnswerResult = z.infer<typeof HarnessDialogAnswerResultSchema>;
