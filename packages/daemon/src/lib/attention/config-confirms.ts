/**
 * AN AGENDA ITEM THAT CONFIRMS A HELD CONFIGURATION CHANGE (docs/agenda.md § Confirming a configuration
 * change). A ferret's edit that loosens what the machine may spend or do is held until the owner confirms it
 * (docs/config-files.md); `fy agenda add --confirms <file>` raises the card that lets the owner's Allow be
 * that confirmation, so nobody has to walk to a terminal afterwards.
 *
 * This module is the card's words and shape, and what an answer to it means. It decides nothing about who
 * may answer — the route does that with the config files' own rule — and it touches no file.
 *
 * - The ask is a choice of exactly {@link ATTENTION_CONFIRMS_ANSWERS}: Allow (right), Deny (left) and Discard
 *   change (up). The option labels ARE the decision, so a card that knows nothing about confirmations still
 *   answers one correctly by choosing.
 * - The premise is the change itself, in the daemon's words, and the line that says what Allow does.
 */

import {
  ATTENTION_CONFIRMS_ANSWERS,
  type AttentionAsk,
  type AttentionCardAnswer,
  type AttentionItem,
  type AttentionResponse,
  clipAtWord,
  MAX_ATTENTION_DETAIL_LENGTH,
  MAX_ATTENTION_REASON_LENGTH,
  toBullets,
} from '@ferretry/protocol';

/** What the owner decided about a held change. */
export type ConfirmationDecision = 'allow' | 'deny' | 'discard';

/** The card a confirmation is: its kind, its ask and its answers, one per direction. */
export interface ConfirmationCard {
  readonly kind: 'choice';
  readonly ask: AttentionAsk;
  readonly answers: AttentionCardAnswer[];
}

/** The ask and the answers of a confirmation of a held change to `path`. */
export function confirmationCard(path: string): ConfirmationCard {
  const allow = { label: ATTENTION_CONFIRMS_ANSWERS.allow, description: `Apply this change to ${path} now` };
  const deny = {
    label: ATTENTION_CONFIRMS_ANSWERS.deny,
    description: 'Keep it held: nothing changes, nothing is lost',
  };
  const discard = {
    label: ATTENTION_CONFIRMS_ANSWERS.discard,
    description: `Put ${path} back to the version in effect`,
  };
  return {
    kind: 'choice',
    ask: { kind: 'multiple-choice', options: [allow, deny, discard] },
    answers: [
      { direction: 'right', does: 'choose', ...allow },
      { direction: 'left', does: 'choose', ...deny },
      { direction: 'up', does: 'choose', ...discard },
    ],
  };
}

/** The line that says, in so many words, what Allow does. */
export const allowLine = (path: string): string => `Allow applies this change to ${path}.`;

/**
 * The card's premise: each change, then what Allow does, then the raiser's own points when they still fit.
 * Past the premise's length the changes that fit are kept and the rest are counted, so the line about Allow
 * is never the one cut.
 */
export function confirmationPremise(path: string, changes: readonly string[], premise?: string): string {
  const own = toBullets([...changes, allowLine(path)]);
  const extra = premise?.trim() ?? '';
  const whole = extra === '' ? own : `${own}\n${extra.startsWith('- ') ? extra : toBullets([extra])}`;
  if (whole.length <= MAX_ATTENTION_REASON_LENGTH) return whole;
  if (own.length <= MAX_ATTENTION_REASON_LENGTH) return own;
  for (let kept = changes.length - 1; kept > 0; kept -= 1) {
    const more = `…and ${String(changes.length - kept)} more (fy config status lists them all)`;
    const shortened = toBullets([...changes.slice(0, kept), more, allowLine(path)]);
    if (shortened.length <= MAX_ATTENTION_REASON_LENGTH) return shortened;
  }
  return toBullets([clipAtWord(changes[0] ?? '', MAX_ATTENTION_REASON_LENGTH / 2), allowLine(path)]);
}

/**
 * What an answer to a confirmation decides: the option it chose, read by its label. `undefined` for an
 * answer that decides nothing about the change — the owner's own words instead of the options.
 */
export function confirmationDecision(response: AttentionResponse): ConfirmationDecision | undefined {
  if (response.kind !== 'multiple-choice') return undefined;
  switch (response.choice.trim()) {
    case ATTENTION_CONFIRMS_ANSWERS.allow:
      return 'allow';
    case ATTENTION_CONFIRMS_ANSWERS.deny:
      return 'deny';
    case ATTENTION_CONFIRMS_ANSWERS.discard:
      return 'discard';
    default:
      return undefined;
  }
}

const OUTCOMES: Readonly<Record<ConfirmationDecision, (path: string) => string>> = {
  allow: path => `confirmed ${path}: the change is in effect`,
  deny: path => `denied: the change to ${path} stays held, not in effect`,
  discard: path => `discarded the held change to ${path}: the version in effect stays`,
};

/**
 * The note the ferret reads with the owner's answer: what the daemon did, first, then the owner's own words
 * when they gave any, clipped so the two fit one note.
 */
export function confirmationNote(decision: ConfirmationDecision, path: string, note?: string | null): string {
  const outcome = OUTCOMES[decision](path);
  const words = note?.trim() ?? '';
  if (words === '') return outcome;
  const room = MAX_ATTENTION_DETAIL_LENGTH - outcome.length - 1;
  return `${outcome}\n${words.length <= room ? words : clipAtWord(words, room)}`;
}

/** Whether an open item confirms a held change: what makes its answer more than a reply. */
export const confirmsChange = (
  item: AttentionItem,
): item is AttentionItem & { readonly confirms: NonNullable<AttentionItem['confirms']> } => item.confirms !== undefined;
