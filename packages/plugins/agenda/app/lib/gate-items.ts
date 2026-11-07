/**
 * GATE VIEWS: an ask drawn as the card ask it carries (`docs/agenda.md` § One ask per thing).
 *
 * A card ask's gate names the card, its lane and what each option does. The ask is drawn as a view of the thread with
 * a multiple choice over those options (`attachedGateView`) and answered like any choice (`{ kind: 'multiple-choice',
 * choice }`), so this module adds only the decisions the agenda needs on top of that:
 *
 * - which answers WAIT FOR WORDS: "Not good" (`reopen-with-agenda`) is refused by the daemon without a reason, so it is
 *   held until the owner has written one; "Not yet" (a one-option gate's other answer, not among `gate.options`) takes
 *   words but never needs them; the forward option needs none;
 */

import {
  AGENDA_KIND_LABELS,
  type AgendaGate,
  type AgendaItem,
  type BoardReopenAttachments,
  cardAskOf,
  openCardAsks,
  gateAnswers,
  gateAskOptions,
  gateReference,
  TEST_KIND_LABEL,
} from '../wire/index.ts';
import type { InboxAction } from './agenda-answers.ts';

/** A view of a thread as the card ask it carries: the card, lane and options. */
export type GateItem = AgendaItem & { readonly gate: AgendaGate };

/** The gate a view stands for; none on a real thread. */
export const gateOf = (item: AgendaItem): AgendaGate | undefined => (item as Partial<GateItem>).gate;

/** The first open card ask's gate: the one a thread shows its Done / Not good for. */
export const firstOpenGate = (item: AgendaItem): AgendaGate | undefined => openCardAsks(item)[0]?.gate;

/** Whether a gate item is a plan to approve ("OK to build"), not a card to test. The one place that reads it. */
export const isPlanGate = (item: Pick<AgendaItem, 'subject'>): boolean => item.subject.startsWith('OK to build');

/** What a gate item is, in the owner's verb: a card to test, or a plan to approve. */
export const gateVerb = (item: Pick<AgendaItem, 'subject'>): string =>
  isPlanGate(item) ? AGENDA_KIND_LABELS.permission : TEST_KIND_LABEL;

export const isGateItem = (item: AgendaItem): item is GateItem => gateOf(item) !== undefined;

/** The option the answer picked, as the owner read it: the label of a multiple choice. */
export const choiceLabel = (action: InboxAction): string | null =>
  action.kind === 'respond' && action.response.kind === 'multiple-choice' ? action.response.choice : null;

export type GateWords = 'required' | 'optional' | 'none';

/**
 * The gate an answer is to: the item's own, or — for an answer marked `gate` — the card ask it names (`cardAsk`),
 * else the one attached to its thread.
 */
const answeredGate = (item: AgendaItem, action: InboxAction): AgendaGate | undefined => {
  if (action.kind !== 'respond' || action.gate !== true) return gateOf(item);
  const named = action.cardAsk === undefined ? undefined : cardAskOf(item, action.cardAsk)?.gate;
  return named ?? firstOpenGate(item);
};

/**
 * What the words box after "Not good" / "Not yet" names: the CARD being tried — its title and id ("Pairing a second
 * phone (&F61)") — never the agenda's own question, which the answer is not about. Falls back to the item's subject,
 * without its closing "?" so the heading does not end in two.
 */
export const gateWhySubject = (item: AgendaItem, action: InboxAction): string => {
  const gate = answeredGate(item, action);
  if (gate !== undefined) {
    const title = gate.cardTitle ?? (gateOf(item) === gate ? item.title : undefined);
    return title === undefined ? `&${gate.cardId}` : `${title} (&${gate.cardId})`;
  }
  return (item.subject ?? item.id).trim().replace(/\?+$/u, '');
};

/**
 * The gate attached to a thread, drawn as the gate item it would be: the same options in the same directions, so the
 * thread's second answer row reads and swipes exactly like the card's own gate item. `undefined` for any other item.
 *
 * The thread's OWN answer shape is left behind (&B156): its questions, steps, form fields, option details and
 * recommendation are the thread's ask, not the card's. Carried over, a thread with several questions made the card
 * ask read as "several questions — answer in words", and its OK to build button was never drawn.
 */
export const attachedGateView = (item: AgendaItem): GateItem | undefined => {
  const gateAttached = firstOpenGate(item);
  const {
    waitingOn: _waitingOn,
    questions: _questions,
    steps: _steps,
    stepsDone: _stepsDone,
    fields: _fields,
    optionDetails: _optionDetails,
    recommendation: _recommendation,
    ...rest
  } = item;
  if (gateAttached === undefined || gateOf(item) !== undefined || item.notice === true) return undefined;
  return {
    ...rest,
    gate: gateAttached,
    kind: 'choice',
    ask: { kind: 'multiple-choice', options: gateAskOptions(gateAttached) },
    answers: gateAnswers(gateAttached),
  };
};

/**
 * What a card ask says about its card, under the heading that names its id: "Badge colour is ready to test." for a card
 * waiting to be tried (its options reopen it), else "Badge colour is at Review."; "It is ..." when the title is not known.
 */
export const attachedGateLead = (gate: AgendaGate): string => {
  return `${gate.cardTitle ?? 'It'} is ${attachedGateStanding(gate)}.`;
};

/** Where the attached card stands, in the owner's words: "ready to test", else "at Review". */
const attachedGateStanding = (gate: AgendaGate): string =>
  gate.options.some(option => option.outcome === 'reopen-with-agenda') ? 'ready to test' : `at ${gate.laneName}`;

/** An answer from the attached gate's row: marked so the daemon answers the gate, never the thread. */
export const toGateAction = (action: InboxAction, gate?: AgendaGate): InboxAction =>
  action.kind === 'respond'
    ? { ...action, gate: true, ...(gate === undefined ? {} : { cardAsk: gateReference(gate) }) }
    : action;

/** Whether this answer to the item takes words: "Not good" needs them, "Not yet" may carry them, the rest take none. */
export const gateWordsFor = (item: AgendaItem, action: InboxAction): GateWords => {
  const gate = answeredGate(item, action);
  if (gate === undefined) return 'none';
  const label = choiceLabel(action);
  if (label === null) return 'none';
  const option = gate.options.find(candidate => candidate.label === label);
  if (option === undefined) return 'optional';
  return option.outcome === 'reopen-with-agenda' ? 'required' : 'none';
};

/** Whether the answer should first open the words box: it takes words (needed or optional) and carries none yet. */
export const gateAsksWords = (item: AgendaItem, action: InboxAction): boolean =>
  gateWordsFor(item, action) !== 'none' && !('note' in action && (action.note ?? '').trim() !== '');

/**
 * The gate's answer as the action to send: the choice, and the owner's words as its note. `attached` marks it as the
 * answer to the thread's first card ask; an ask's gate or its reference names which one the owner was looking at.
 */
export const gateAnswerAction = (
  label: string,
  words: string,
  attached: boolean | string | AgendaGate = false,
  attachments?: BoardReopenAttachments,
): InboxAction => {
  const note = words.trim();
  return {
    kind: 'respond',
    label,
    response: { kind: 'multiple-choice', choice: label },
    ...(note === '' ? {} : { note }),
    ...(attached === false ? {} : { gate: true as const }),
    ...(typeof attached === 'object' ? { cardAsk: gateReference(attached) } : {}),
    ...(typeof attached === 'string' ? { cardAsk: attached } : {}),
    ...(attachments === undefined ? {} : { attachments }),
  };
};
