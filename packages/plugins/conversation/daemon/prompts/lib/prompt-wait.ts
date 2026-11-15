import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type PromptAskRef, PromptAskRefSchema } from '../../../contract/wire-prompt.ts';

/** What Ferrets says a pane is asking (`FerretsApi.prompt`), as far as a wait on the owner is read from it. */
export interface PromptRead {
  readonly turnState?: 'working' | 'your-turn' | 'needs-input';
  readonly prompt?: string;
  readonly permissionRequest?: unknown;
  readonly dialog?: unknown;
}

/** One wait of a ferret on the owner that is not a structured question: the card it is, and the words behind it. */
export interface PromptWait {
  readonly ref: PromptAskRef;
  /** The wait's own words, whole and on one line: the card's context, never its subject. */
  readonly words: string;
}

/**
 * What one look at a pane means for the card: parked on a wait of this source, positively NOT waiting (the turn moved
 * on, or the question is its own card), or no evidence either way (nothing recorded, nothing readable). Only `ended`
 * closes a card: an empty or failed read says nothing about whether the wait is over.
 */
export type PromptReading =
  | { readonly kind: 'waiting'; readonly wait: PromptWait }
  | { readonly kind: 'ended' }
  | { readonly kind: 'unknown' };

/** Only the words the card needs; the pane's whole prompt (options, cursor) is Ferrets' and stays there. */
const PermissionWords = z.looseObject({
  id: z.string().min(1),
  tool: z.string().min(1),
  what: z.string().min(1).optional(),
  question: z.string().min(1),
});
const DialogWords = z.looseObject({ id: z.string().min(1), title: z.string().min(1) });

/** One line: whitespace collapsed and trimmed. The identity of a prompt is hashed from THIS whole, never a clipped copy. */
const oneLine = (words: string): string => words.replace(/\s+/gu, ' ').trim();

const digestOf = (words: string): string => createHash('sha256').update(words).digest('hex').slice(0, 32);

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
      words: oneLine(
        `Permission: ${permission.data.tool}${permission.data.what === undefined ? '' : ` ${permission.data.what}`}. ${permission.data.question}`,
      ),
    };
  const dialog = DialogWords.safeParse(read.dialog);
  if (dialog.success)
    return { ref: { kind: 'dialog', prompt: dialog.data.id }, words: oneLine(`Dialog: ${dialog.data.title}`) };
  const words = read.prompt === undefined ? '' : oneLine(read.prompt);
  if (words === '') return undefined;
  return { ref: { kind: 'prompt', prompt: digestOf(words) }, words };
}

/** Reads one look at a pane for the card: see {@link PromptReading}. Total. */
export function readPrompt(read: PromptRead | undefined): PromptReading {
  if (read?.turnState === undefined) return { kind: 'unknown' };
  const wait = promptWait(read);
  return wait === undefined ? { kind: 'ended' } : { kind: 'waiting', wait };
}

/** The wait's kind and the prompt's own id: what makes a different prompt a different wait. */
export const promptKey = (ref: PromptAskRef): string => `${ref.kind}:${ref.prompt}`;

/** The wait a key names (the inverse of {@link promptKey}), or `undefined` for a key that names none. Total. */
export function promptRefOfKey(key: string): PromptAskRef | undefined {
  const colon = key.indexOf(':');
  const parsed = PromptAskRefSchema.safeParse({ kind: key.slice(0, colon), prompt: key.slice(colon + 1) });
  return parsed.success ? parsed.data : undefined;
}

const SUBJECT_KIND: Readonly<Record<PromptAskRef['kind'], string>> = {
  permission: 'a permission answer',
  dialog: 'an answer to a dialog',
  prompt: 'an answer',
};

/** The card's subject, v4's words: who waits and on what kind of answer. The prompt's own words are the context. */
export const promptSubject = (ferret: string, ref: PromptAskRef): string => `${ferret} needs ${SUBJECT_KIND[ref.kind]}`;

/**
 * The card's entry id: the ferret, the prompt and which OCCURRENCE of waiting it is. The same prompt of the same ferret
 * is the same card for as long as the wait lasts, and the same prompt asked again after the wait ended is a new one.
 */
export const promptEntry = (ferret: string, ref: PromptAskRef, occurrence: number): string =>
  `p:${createHash('sha256').update(ferret).update('\0').update(ref.kind).update('\0').update(ref.prompt).update('\0').update(String(occurrence)).digest('hex').slice(0, 40)}`;
