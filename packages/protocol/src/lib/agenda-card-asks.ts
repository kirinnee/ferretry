/**
 * CARD ASKS — the pure facts both ends read off `AgendaItem.cardAsks` (docs/agenda.md § Card asks): which asks are
 * open, which one an older app is shown, which card an agenda carries, the stage an ask puts it in, and the
 * reference of the agenda the daemon opens for a card nobody's agenda carries yet. Total.
 */
import type { AgendaCardAsk, AgendaGate, AgendaItem } from './agenda.ts';
import { gateReference } from './agenda-gate.ts';
import type { AgendaStage } from './agenda-state.ts';
import type { TaskRef } from './board-refs.ts';

/** The prefix of the `sourceRef` of the agenda the daemon opens for a card: `card-agenda:<card>`. */
const CARD_AGENDA_REFERENCE_PREFIX = 'card-agenda:';
const CARD_ID = /^[BFIC][1-9][0-9]{0,8}$/u;

/** The `sourceRef` of the one agenda the daemon opens, on the card's ferret's behalf, for a card nobody's agenda carries. */
export const cardAgendaReference = (cardId: string): string => `${CARD_AGENDA_REFERENCE_PREFIX}${cardId}`;

/** The card a `card-agenda:` reference names, or `undefined` for any other reference. */
export const parseCardAgendaReference = (sourceRef: string | null | undefined): string | undefined => {
  if (typeof sourceRef !== 'string' || !sourceRef.startsWith(CARD_AGENDA_REFERENCE_PREFIX)) return undefined;
  const cardId = sourceRef.slice(CARD_AGENDA_REFERENCE_PREFIX.length);
  return CARD_ID.test(cardId) ? cardId : undefined;
};

/** A card ask's stable name: its gate's reference, one per entry of the card into the lane. */
export const cardAskReference = (ask: Pick<AgendaCardAsk, 'gate'>): string => gateReference(ask.gate);

/** Whether the owner has yet to answer this ask. */
export const isOpenCardAsk = (ask: Pick<AgendaCardAsk, 'answer'>): boolean => ask.answer === undefined;

/** An agenda's open card asks, oldest first. */
export const openCardAsks = (item: { readonly cardAsks?: readonly AgendaCardAsk[] | undefined }): AgendaCardAsk[] =>
  (item.cardAsks ?? []).filter(isOpenCardAsk);

/** Whether an agenda carries a card ask the owner has yet to answer: that makes it a blocker of its card. */
export const hasOpenCardAsk = (item: { readonly cardAsks?: readonly Pick<AgendaCardAsk, 'answer'>[] | undefined }) =>
  (item.cardAsks ?? []).some(isOpenCardAsk);

/** The card ask an app that predates card asks is shown (`gateAttached`): the first open one. */
export const mirroredCardAsk = (item: {
  readonly cardAsks?: readonly AgendaCardAsk[] | undefined;
}): AgendaCardAsk | undefined => openCardAsks(item)[0];

/** The card ask on this agenda with this reference, open or answered. */
export const cardAskOf = (
  item: { readonly cardAsks?: readonly AgendaCardAsk[] | undefined },
  reference: string,
): AgendaCardAsk | undefined => (item.cardAsks ?? []).find(ask => cardAskReference(ask) === reference);

/** What a card ask needs of the owner: a test to try (its gate can send the card back with words), else a plan to approve. */
export const cardAskStage = (gate: Pick<AgendaGate, 'options'>): Extract<AgendaStage, 'test' | 'plan'> =>
  gate.options.some(option => option.outcome === 'reopen-with-agenda') ? 'test' : 'plan';

const sameCard = (ref: TaskRef, cardId: string, machineId: string | undefined): boolean =>
  ref.id === cardId && (ref.machineId === undefined || machineId === undefined || ref.machineId === machineId);

/**
 * Whether an agenda CARRIES a card: it is about the card (`task`), or it carries one of the card's asks. A notice
 * carries nothing: it is read, never answered.
 */
export const carriesCard = (
  item: Pick<AgendaItem, 'task' | 'cardAsks' | 'notice'> & { readonly relatedTasks?: readonly TaskRef[] | undefined },
  cardId: string,
  machineId?: string,
): boolean => {
  if (item.notice === true) return false;
  if (item.task !== undefined && item.task !== null && sameCard(item.task, cardId, machineId)) return true;
  // The cards a merge brought in (`relatedTasks`, docs/agenda.md § Merge and split) ride the agenda too.
  if ((item.relatedTasks ?? []).some(ref => sameCard(ref, cardId, machineId))) return true;
  return (item.cardAsks ?? []).some(ask => ask.gate.cardId === cardId);
};
