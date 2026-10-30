/**
 * THE OPTIONS OF AN AGENDA ITEM, LETTERED: "A — <label>", then its explanation. The Options section and the quick
 * replies draw from this one list, so a button that says "B" and the section that says "B — Keep both" can never
 * disagree. An option's explanation is the item's `optionDetails` entry (Markdown) when it has one, else the
 * option's own one-line `description`. Pure.
 */

import type { AgendaAskOption, AgendaItem } from '@ferretry/protocol';
import { singleAgendaQuestion } from '@ferretry/protocol';

export interface LetteredOption {
  readonly letter: string;
  readonly label: string;
  /** Markdown: what picking it means and why. */
  readonly detail: string | undefined;
  readonly recommended: boolean;
}

const same = (a: string, b: string | undefined): boolean =>
  b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A, B, C… in display order. An item has at most twelve options per question. */
export const optionLetter = (index: number): string => String.fromCharCode(65 + index);

/** The options in display order, each with its letter, its explanation and whether it is the recommended one. */
export const letteredOptions = (
  options: readonly AgendaAskOption[],
  details: AgendaItem['optionDetails'],
  recommended: string | undefined,
): readonly LetteredOption[] =>
  options.map((option, index) => ({
    letter: optionLetter(index),
    label: option.label,
    detail: details?.find(entry => same(entry.label, option.label))?.detail ?? option.description,
    recommended: same(option.label, recommended),
  }));

/** The options a lone question or a choice ask offers; none for a several-question item (each question has its own). */
export const itemOptions = (item: AgendaItem): readonly AgendaAskOption[] => {
  if (item.ask?.kind === 'multiple-choice') return item.ask.options;
  return singleAgendaQuestion(item)?.options ?? [];
};

/** The letter of an option label among `options`, or `undefined` when the label is not one of them. */
export const letterOf = (options: readonly AgendaAskOption[], label: string): string | undefined => {
  const at = options.findIndex(option => same(option.label, label));
  return at < 0 ? undefined : optionLetter(at);
};

/** A label this short is its own button text; a longer one is drawn as its letter. */
const SHORT_LABEL_WORDS = 2;
/** A single word longer than this would break mid-word in a third of a phone's width, so it is drawn as its letter. */
const SHORT_WORD_CHARS = 8;

/**
 * What a quick-reply button says: the label when it is one or two words ("Looks good"), else its letter. A label
 * too long with no letter is left whole — the row clips it, and its full text is the accessible name.
 */
export const shortLabel = (label: string, letter: string | undefined, lettered = false): string => {
  if (letter === undefined) return label;
  return lettered || tooLong(label) ? letter : label;
};

const wordsOf = (label: string): string[] => label.trim().split(/\s+/u);

/** Too long to stand as a button: more than two words, or one word that would break mid-word. */
const tooLong = (label: string): boolean => {
  const words = wordsOf(label);
  return words.length > SHORT_LABEL_WORDS || words.some(word => word.length > SHORT_WORD_CHARS);
};

/**
 * Whether a ROW of quick replies is drawn as letters: one lettered label too long to stand as a button letters the
 * whole row, so it reads one way ("A B C"), never a mix of words and letters.
 */
export const rowLettered = (
  replies: readonly { readonly label: string; readonly letter: string | undefined }[],
): boolean => replies.some(reply => reply.letter !== undefined && tooLong(reply.label));

/**
 * Whether the Options section earns its place: some option says more than its label, or some quick reply is
 * drawn as a bare letter that the section has to explain. A plain "Yes / No" would only repeat its buttons.
 */
export const needsOptionsSection = (options: readonly LetteredOption[]): boolean => {
  const lettered = rowLettered(options);
  return options.some(
    option => option.detail !== undefined || shortLabel(option.label, option.letter, lettered) !== option.label,
  );
};
