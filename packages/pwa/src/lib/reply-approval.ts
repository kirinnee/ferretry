/**
 * A REPLY THAT ALREADY SAYS YES TO THE CARD ASK (&B155). The owner answered an item holding a card ask in words —
 * "build", "ok to build!" — and the card stayed where it was: only the card ask's own button moves the card, and the
 * ferret may not press it. So when the owner's latest words on the item are a PLAIN approval, the card ask offers that
 * reply as its answer, one tap away. It is only offered, never applied.
 *
 * Conservative on purpose — anything else offers nothing:
 * - the item holds exactly ONE card ask, and that ask has exactly one forward option (not the one that sends the card
 *   back with words);
 * - the owner's words are the LAST thing on the item (no ferret reply, edit or answer form after them);
 * - the words, once case, spaces, closing punctuation and an approving emoji are set aside, are one of a short list of
 *   approvals, or the forward option's own label. Nothing longer is read: "build it after lunch" offers nothing.
 */

import type { AgendaGate } from '@ferretry/protocol';
import type { HistoryEvent } from './agenda-history.ts';

/** The words that alone mean "yes, go on" to any card ask, in lower case. */
const APPROVALS: ReadonlySet<string> = new Set([
  'yes',
  'yep',
  'yeah',
  'ok',
  'okay',
  'go',
  'go ahead',
  'go for it',
  'approve',
  'approved',
  'lgtm',
  'looks good',
  'looks good to me',
  'sounds good',
  'ship it',
  'do it',
  'all good',
]);

/** The words that approve only a plan ("OK to build"): a tested card is never "built". */
const BUILD_APPROVALS: ReadonlySet<string> = new Set([
  'build',
  'build it',
  'go build',
  'ok build',
  'ok to build',
  'okay to build',
]);

/** The words that pass only a card waiting to be tried ("Done"): a plan is never "tested". */
const TEST_APPROVALS: ReadonlySet<string> = new Set(['done', 'works', 'it works', 'tested', 'works for me']);

/** The longest reply that is read at all: an approval is a word or a few. */
const MAX_APPROVAL_LENGTH = 32;

/** A reply as an approval is compared: lower case, one space, no closing punctuation or approving emoji. */
const normal = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\u{1F44D}|\u{2705}|\u{1F680}|\u{1F64F}|\u{FE0F}/gu, ' ')
    .replace(/[.!,;:]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

export interface ReplyApproval {
  /** The owner's words, as they wrote them. */
  readonly reply: string;
  /** The card ask's forward option those words approve: the button the offer presses. */
  readonly label: string;
}

/** The forward option of a card ask: the one option that does not send the card back; none when there are several. */
const forwardLabel = (gate: AgendaGate): string | null => {
  const forward = gate.options.filter(option => option.outcome !== 'reopen-with-agenda');
  return forward.length === 1 ? (forward[0]?.label ?? null) : null;
};

/** The owner's latest words, when they are the last thing on the item; `null` when anything came after them. */
const lastOwnerReply = (history: readonly HistoryEvent[]): string | null => {
  const last = history
    .filter(event => event.kind !== 'gap')
    .sort((a, b) => a.at - b.at)
    .at(-1);
  if (last === undefined || last.kind !== 'owner' || last.form !== undefined) return null;
  return last.text;
};

/**
 * The approval to offer on an item's card asks, or `null`. `asks` are the item's open card asks; only one is ever
 * offered to, and only when the owner's last words plainly approve it.
 */
export const replyApproval = (asks: readonly AgendaGate[], history: readonly HistoryEvent[]): ReplyApproval | null => {
  const [gate] = asks;
  if (asks.length !== 1 || gate === undefined) return null;
  const label = forwardLabel(gate);
  const reply = lastOwnerReply(history);
  if (label === null || reply === null || reply.trim().length > MAX_APPROVAL_LENGTH) return null;
  const said = normal(reply);
  const named = normal(label);
  const fits =
    APPROVALS.has(said) ||
    said === named ||
    (named.includes('build') && BUILD_APPROVALS.has(said)) ||
    (named === 'done' && TEST_APPROVALS.has(said));
  return fits ? { reply: reply.trim(), label } : null;
};
