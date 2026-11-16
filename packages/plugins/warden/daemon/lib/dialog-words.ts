/**
 * THE WORDS OF A DIALOG, for the clearer and the learner only.
 *
 * The dialog look reads a dialog's id, harness and kind and nothing else (`WatchedDialogSchema`): its title, rows and a
 * tool prompt's command are pane text, and the notice and the agenda must never carry them. A rule has to read them — it
 * names a screen by its title and a row by its label — so this is a SECOND, separate read, held in memory for the one
 * press and never logged, stored or put in a notice. The learner shows a screen's own title and rows only to the owner
 * who asked to teach it (after the masker), and keeps nothing but a rule.
 */
import { z } from 'zod';

const ClearableDialogSchema = z.object({
  id: z.string().min(1),
  harness: z.string().optional(),
  kind: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  options: z
    .array(z.looseObject({ number: z.number(), label: z.string(), grantsTrust: z.boolean().optional() }))
    .default([]),
  escape: z.string().optional(),
});
export type ClearableDialogWords = z.infer<typeof ClearableDialogSchema>;

const ClearablePermissionSchema = z.object({
  id: z.string().min(1),
  harness: z.string().optional(),
  tool: z.string().min(1),
  question: z.string().min(1),
});

/** A tool-permission prompt as a rule reads it: its question is the title and its tool opens the body. */
function permissionWords(permissionRequest: unknown): ClearableDialogWords | undefined {
  const read = ClearablePermissionSchema.safeParse(permissionRequest);
  if (!read.success) return undefined;
  const { id, harness, tool, question } = read.data;
  return {
    id,
    ...(harness === undefined ? {} : { harness }),
    kind: 'permission',
    title: question,
    body: tool,
    options: [],
  };
}

/** What a ferret's `prompt` says of its dialog, as words: a screen, else a tool prompt, else nothing. */
export function dialogWordsOf(prompt: { readonly dialog?: unknown; readonly permissionRequest?: unknown } | undefined) {
  const screen = ClearableDialogSchema.safeParse(prompt?.dialog);
  return screen.success ? screen.data : permissionWords(prompt?.permissionRequest);
}
