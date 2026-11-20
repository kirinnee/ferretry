/**
 * WORDS TYPED AT A TRY-IT THAT PLAINLY SAY YES (&B155). The owner typed "works now" under an item that asks them to try
 * something: that is Good, not Not good, so the composer sends it as an ordinary reply and the ferret reads it. Nothing is
 * shown back to the owner about it (a second prompt next to the Good button read as a second ask).
 *
 * Conservative on purpose — anything else is the other answer:
 * - the ask has exactly ONE forward option (not the one that sends the card back with words);
 * - the words, once case, spaces, closing punctuation and an approving emoji are set aside, are one of a short list of
 *   approvals, or the forward option's own label. Nothing longer is read: "works but the colour is off" is Not good.
 */

import { type AgendaGate, type GateStyle, gateStyle } from '@ferretry/protocol';

/** The words that alone mean "yes, go on" to any card ask, in lower case. */
const APPROVALS: ReadonlySet<string> = new Set([
  'yes',
  'yep',
  'yeah',
  'ok',
  'okay',
  'good',
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

/** The words that approve only a plan ("OK to build"): a card at a try-it is never "built". */
const BUILD_APPROVALS: ReadonlySet<string> = new Set([
  'build',
  'build it',
  'go build',
  'ok build',
  'ok to build',
  'okay to build',
]);

/** The words that pass only a card waiting to be tried, whatever its lane calls the pass: a plan is never "tested". */
const TEST_APPROVALS: ReadonlySet<string> = new Set([
  'done',
  'works',
  'it works',
  'works now',
  'it works now',
  'works fine',
  'it works fine',
  'works great',
  'it works great',
  'works well',
  'it works well',
  'good now',
  'tested',
  'tested ok',
  'tested okay',
  'works for me',
]);

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

/**
 * Whether plain words approve a gate whose forward option is `label`: one of the short approvals, the option's own
 * label, and then the style's own words — a tester's at a try-it (whatever the lane calls its pass), a plan's build
 * words at an approval. Whatever else, a longer message, a question, a negation or a "but" clause, is not an
 * approval: the match is of the WHOLE message.
 */
const approvesWith = (label: string, reply: string, style: GateStyle): boolean => {
  if (reply.length > MAX_APPROVAL_LENGTH) return false;
  const said = normal(reply);
  const named = normal(label);
  return (
    APPROVALS.has(said) ||
    said === named ||
    (style === 'approval' && named.includes('build') && BUILD_APPROVALS.has(said)) ||
    (style === 'try-it' && TEST_APPROVALS.has(said))
  );
};

/**
 * The pass option typed words approve at a TRY-IT, or `null`: "works now", "lgtm", "good" typed under a card to try
 * mean Good, not Not good. An approval gate never reads typed words as a yes ("ok" there is a Not yet word).
 */
export const typedApproval = (gate: AgendaGate, words: string): string | null => {
  const label = forwardLabel(gate);
  return label !== null && gateStyle(gate) === 'try-it' && approvesWith(label, words.trim(), 'try-it') ? label : null;
};

/** The forward option of a card ask: the one option that does not send the card back; none when there are several. */
const forwardLabel = (gate: AgendaGate): string | null => {
  const forward = gate.options.filter(option => option.outcome !== 'reopen-with-agenda');
  return forward.length === 1 ? (forward[0]?.label ?? null) : null;
};
