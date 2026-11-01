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

import type { AgendaGate, AgendaItem } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import type { InboxAction } from './agenda-answers.ts';
import type { ToTestCard } from './to-test-inbox.ts';

/** An item that is a gate: it carries the card, lane and options. */
export type GateItem = AgendaItem & { readonly gate: AgendaGate };

/** The two gates the owner is asked at: a card to try, or a plan to approve. */
export const gateStageWords = (item: GateItem): string =>
  item.subject?.startsWith('OK to build') ? 'OK to build?' : 'Try it';

/** The chip a gate item wears: the lane's verb. */
export const gateVerb = (item: AgendaItem): string => (item.subject.startsWith('OK to build') ? 'Approve' : 'Try it');

export const isGateItem = (item: AgendaItem): item is GateItem => item.gate !== undefined;

/** The option the answer picked, as the owner read it: the label of a multiple choice. */
export const choiceLabel = (action: InboxAction): string | null =>
  action.kind === 'respond' && action.response.kind === 'multiple-choice' ? action.response.choice : null;

export type GateWords = 'required' | 'optional' | 'none';

/** Whether this answer to the item takes words: "Not good" needs them, "Not yet" may carry them, the rest take none. */
export const gateWordsFor = (item: AgendaItem, action: InboxAction): GateWords => {
  if (!isGateItem(item)) return 'none';
  const label = choiceLabel(action);
  if (label === null) return 'none';
  const option = item.gate.options.find(candidate => candidate.label === label);
  if (option === undefined) return 'optional';
  return option.outcome === 'reopen-with-agenda' ? 'required' : 'none';
};

/** Whether the answer must wait: it needs words and carries none. */
export const gateHeld = (item: AgendaItem, action: InboxAction): boolean =>
  gateWordsFor(item, action) === 'required' && !('note' in action && (action.note ?? '').trim() !== '');

/** Whether the answer should first open the words box: it takes words (needed or optional) and carries none yet. */
export const gateAsksWords = (item: AgendaItem, action: InboxAction): boolean =>
  gateWordsFor(item, action) !== 'none' && !('note' in action && (action.note ?? '').trim() !== '');

/** The option "Not good" is, if the gate has one. */
export const gateReopenOption = (item: GateItem): AgendaGate['options'][number] | undefined =>
  item.gate.options.find(option => option.outcome === 'reopen-with-agenda');

/** The gate's answer as the action to send: the choice, and the owner's words as its note. */
export const gateAnswerAction = (label: string, words: string): InboxAction => {
  const note = words.trim();
  return {
    kind: 'respond',
    label,
    response: { kind: 'multiple-choice', choice: label },
    ...(note === '' ? {} : { note }),
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
