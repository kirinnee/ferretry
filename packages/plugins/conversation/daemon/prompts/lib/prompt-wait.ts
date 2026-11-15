import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PromptAskRef } from '../../../contract/wire-prompt.ts';

/** What Ferrets says a pane is asking (`FerretsApi.prompt`), as far as a wait on the owner is read from it. */
export interface PromptRead {
  readonly turnState?: 'working' | 'your-turn' | 'needs-input';
  readonly prompt?: string;
  readonly permissionRequest?: unknown;
  readonly dialog?: unknown;
}

/** One wait of a ferret on the owner that is not a structured question: the card it is, and the prompt's own id. */
export interface PromptWait {
  readonly ref: PromptAskRef;
  readonly subject: string;
}

const MAX_SUBJECT = 240;

/** Only the words the card needs; the pane's whole prompt (options, cursor) is Ferrets' and stays there. */
const PermissionWords = z.looseObject({
  id: z.string().min(1),
  tool: z.string().min(1),
  what: z.string().min(1).optional(),
  question: z.string().min(1),
});
const DialogWords = z.looseObject({ id: z.string().min(1), title: z.string().min(1) });

/** One line, bounded: the prompt's words as the card's subject. */
const oneLine = (words: string): string => {
  const line = words.replace(/\s+/gu, ' ').trim();
  return line.length <= MAX_SUBJECT ? line : `${line.slice(0, MAX_SUBJECT - 1)}…`;
};

/**
 * What the ferret is waiting on besides a question, or `undefined` when it is not parked on a prompt. A permission
 * prompt, a harness dialog and the pane's own words are read in that order (the first that is there names the wait);
 * a `needs-input` with none of them is a structured question, whose card is the question's own. Total.
 */
export function promptWait(read: PromptRead | undefined): PromptWait | undefined {
  if (read?.turnState !== 'needs-input') return undefined;
  const permission = PermissionWords.safeParse(read.permissionRequest);
  if (permission.success)
    return {
      ref: { kind: 'permission', prompt: permission.data.id },
      subject: oneLine(
        `Permission: ${permission.data.tool}${permission.data.what === undefined ? '' : ` ${permission.data.what}`}`,
      ),
    };
  const dialog = DialogWords.safeParse(read.dialog);
  if (dialog.success)
    return { ref: { kind: 'dialog', prompt: dialog.data.id }, subject: oneLine(`Dialog: ${dialog.data.title}`) };
  const words = read.prompt === undefined ? '' : oneLine(read.prompt);
  if (words === '') return undefined;
  const digest = createHash('sha256').update(words).digest('hex').slice(0, 16);
  return { ref: { kind: 'prompt', prompt: digest }, subject: words };
}

/** The card's entry id: the ferret and the prompt together, so the same prompt is the same card and another's is not. */
export const promptEntry = (ferret: string, ref: PromptAskRef): string =>
  `p:${createHash('sha256').update(ferret).update('\0').update(ref.kind).update('\0').update(ref.prompt).digest('hex').slice(0, 40)}`;
