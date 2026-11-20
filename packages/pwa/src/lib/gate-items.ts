/**
 * GATE ITEMS: the Inbox's cards that ARE a board card waiting on the owner's try (`docs/agenda.md` § Gate items).
 *
 * A gate item is an ordinary agenda item whose ask is a multiple choice, plus the optional `gate` field that names the
 * card, its lane and what each option does. It is answered like any choice (`{ kind: 'multiple-choice', choice }`), so
 * this module adds only the three decisions the Inbox needs on top of that:
 *
 * - which answers WAIT FOR WORDS: "Not good" (`reopen-with-agenda`) is refused by the daemon without a reason, so it is
 *   held until the owner has written one; "Not yet" (a one-option gate's other answer, not among `gate.options`) takes
 *   words but never needs them; the forward option needs none;
 * - which synthesized to-test rows a gate item REPLACES, on a machine that advertises `board.gate-items.1`.
 */

import {
  AGENDA_KIND_LABELS,
  type AgendaGate,
  type AgendaItem,
  type BoardReopenAttachments,
  cardAskOf,
  cardAskStage,
  gateAnswers,
  gateAskOptions,
  gateReference,
  TEST_KIND_LABEL,
} from '@ferretry/protocol';
import type { InboxAction } from './agenda-answers.ts';
import type { DaemonId } from './daemon-connection.ts';
import type { ToTestCard } from './to-test-inbox.ts';

/** An item that is a gate: it carries the card, lane and options. */
export type GateItem = AgendaItem & { readonly gate: AgendaGate };

/** Whether a gate item is a plan to approve ("OK to build"), not a card to test. The one place that reads it. */
export const isPlanGate = (item: Pick<AgendaItem, 'subject'>): boolean => item.subject.startsWith('OK to build');

/** What a gate item is, in the owner's verb: a card to test, or a plan to approve. */
export const gateVerb = (item: Pick<AgendaItem, 'subject'>): string =>
  isPlanGate(item) ? AGENDA_KIND_LABELS.permission : TEST_KIND_LABEL;

export const isGateItem = (item: AgendaItem): item is GateItem => item.gate !== undefined;

/** The option the answer picked, as the owner read it: the label of a multiple choice. */
export const choiceLabel = (action: InboxAction): string | null =>
  action.kind === 'respond' && action.response.kind === 'multiple-choice' ? action.response.choice : null;

export type GateWords = 'required' | 'optional' | 'none';

/**
 * The gate an answer is to: the item's own, or — for an answer marked `gate` — the card ask it names (`cardAsk`),
 * else the one attached to its thread.
 */
const answeredGate = (item: AgendaItem, action: InboxAction): AgendaGate | undefined => {
  if (action.kind !== 'respond' || action.gate !== true) return item.gate;
  const named = action.cardAsk === undefined ? undefined : cardAskOf(item, action.cardAsk)?.gate;
  return named ?? item.gateAttached;
};

/**
 * What the words box after "Not good" / "Not yet" names: the CARD being tried — its title and id ("Pairing a second
 * phone (&F61)") — never the agenda's own question, which the answer is not about. Falls back to the item's subject,
 * without its closing "?" so the heading does not end in two.
 */
export const gateWhySubject = (item: AgendaItem, action: InboxAction): string => {
  const gate = answeredGate(item, action);
  if (gate !== undefined) {
    const title = gate.cardTitle ?? (item.gate === gate ? item.title : undefined);
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
export const gateViewOf = (item: AgendaItem, gate: AgendaGate | undefined): GateItem | undefined => {
  const {
    gateAttached: _gateAttached,
    waitingOn: _waitingOn,
    questions: _questions,
    steps: _steps,
    stepsDone: _stepsDone,
    fields: _fields,
    optionDetails: _optionDetails,
    recommendation: _recommendation,
    ...rest
  } = item;
  if (gate === undefined || item.gate !== undefined || item.notice === true) return undefined;
  return {
    ...rest,
    gate,
    kind: 'choice',
    ask: { kind: 'multiple-choice', options: gateAskOptions(gate) },
    answers: gateAnswers(gate),
  };
};

/** The gate attached to a thread (the one-ask mirror), drawn as the gate item it would be. */
export const attachedGateView = (item: AgendaItem): GateItem | undefined => gateViewOf(item, item.gateAttached);

/**
 * What a card ask is, in the owner's verb: a card to try, or a plan to approve. It is the ask's own heading: the ask is
 * the item's, so it never says "card" or "your answer for the card".
 */
export const attachedGateHeading = (gate: AgendaGate): string => (cardAskStage(gate) === 'test' ? 'Try it' : 'Approve');

/**
 * The one plain line that names the card a card ask is about: "For &F12 Badge colour" (the id alone when the title is
 * not known). A reference, not a heading; a title the ask's own heading already carries is left out.
 */
export const attachedGateReference = (gate: AgendaGate, withTitle = true): string =>
  `For &${gate.cardId}${withTitle && gate.cardTitle !== undefined ? ` ${gate.cardTitle}` : ''}`;

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
 * answer to the card ask an older app is shown; an ask's gate or its reference names which one the owner was looking at.
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

/** The cards that have an open gate item, per machine: `daemon\0card`. */
const coverKey = (daemonId: DaemonId, cardId: string): string => `${daemonId}\u0000${cardId}`;

/**
 * The to-test rows still to show. On a machine that advertises gate items a row is replaced by the gate item that
 * covers it — and kept when none is open, so a person-asked card in a gate lane without one is never lost. A machine
 * that does not advertise them keeps every row, exactly as before.
 */
export const toTestBesideGates = (
  rows: readonly ToTestCard[],
  gated: ReadonlyArray<{ readonly daemonId: DaemonId; readonly item: AgendaItem }>,
  offersGates: (daemonId: DaemonId) => boolean,
): readonly ToTestCard[] => {
  const covered = new Set(
    gated.flatMap(({ daemonId, item }) => (item.gate === undefined ? [] : [coverKey(daemonId, item.gate.cardId)])),
  );
  return rows.filter(
    row => !offersGates(row.card.daemonId) || !covered.has(coverKey(row.card.daemonId, row.card.task.id)),
  );
};
