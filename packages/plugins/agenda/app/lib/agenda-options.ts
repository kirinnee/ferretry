/**
 * THE OPTIONS OF AN AGENDA ITEM, LETTERED: "A — <label>", then its explanation, for the options list. The answer
 * buttons never say a letter: each says its option's short label (`agendaAnswerText`). An option's explanation is the item's `optionDetails` entry (Markdown) when it has one, else the
 * option's own one-line `description`. Pure.
 */

import type { AgendaAskOption, AgendaItem } from '../wire/index.ts';
import { singleAgendaQuestion, yesNoOrder } from '../wire/index.ts';

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

/**
 * The options a lone question or a choice ask offers; none for a several-question item (each question has its own).
 * Yes and No are listed No, Yes, as their buttons sit (`yesNoOrder`).
 */
export const itemOptions = (item: AgendaItem): readonly AgendaAskOption[] =>
  yesNoOrder(
    item.ask?.kind === 'multiple-choice' ? item.ask.options : (singleAgendaQuestion(item)?.options ?? []),
    option => option.label,
  );

/** A label this short names itself in the Options section; a longer one is named there by its letter. */
const SHORT_LABEL_WORDS = 2;
/** A single word longer than this would break mid-word in a third of a phone's width, so it is named by its letter. */
const SHORT_WORD_CHARS = 8;

/**
 * What the Options section names an option by: the label when it is one or two words ("Looks good"), else its
 * letter. A label too long with no letter is left whole.
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
 * Whether the Options section names a ROW of options by letter: one lettered label too long to stand alone letters
 * them all, so it reads one way ("A B C"), never a mix of words and letters.
 */
export const rowLettered = (
  replies: readonly { readonly label: string; readonly letter: string | undefined }[],
): boolean => replies.some(reply => reply.letter !== undefined && tooLong(reply.label));

/**
 * Whether the Options section earns its place: some option says more than its label, or some label is too long to
 * stand alone (its button cuts it), so the section names it whole. A plain "Yes / No" would only repeat its buttons.
 */
export const needsOptionsSection = (options: readonly LetteredOption[]): boolean => {
  const lettered = rowLettered(options);
  return options.some(
    option => option.detail !== undefined || shortLabel(option.label, option.letter, lettered) !== option.label,
  );
};

/** The longest single word the card draws as an option's name; anything longer, or two words, is drawn as a letter. */
const ONE_WORD_CHARS = 12;

/** One word, short enough to name an option on its own: "Pause", "Switch". */
export const isOneWord = (label: string): boolean => {
  const words = wordsOf(label);
  return words.length === 1 && (words[0] ?? '').length <= ONE_WORD_CHARS;
};

/**
 * Whether the card's options LIST names its options by letter: one label that is not a single short word letters
 * them all, so the list reads one way ("A B C"), never a mix of words and letters. Its buttons still say the labels.
 */
export const cardLettered = (options: readonly { readonly label: string }[]): boolean =>
  options.some(option => !isOneWord(option.label));
