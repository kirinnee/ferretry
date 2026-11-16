// VENDORED from v4.291.5 (64fd8cbcc811e2341f1ab18be170d76106a44852) packages/protocol/src/lib/agenda-card-asks.ts, verbatim.
// The converter's own frozen v4 reader: never imported by the product. Do not edit; re-vendor instead.
/**
 * CARD ASKS — the pure facts both ends read off `AgendaItem.cardAsks` (docs/agenda.md § Card asks): which asks are
 * open, which one an older app is shown, which card an agenda carries, the stage an ask puts it in, and the
 * reference of the agenda the daemon opens for a card nobody's agenda carries yet. Total.
 */
import type { AgendaCardAsk, AgendaGate, AgendaItem } from './agenda.ts';
import { gateReference, parseGateFollowupReference } from './agenda-gate.ts';
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

/**
 * Whether an agenda asks the owner NOTHING BUT its card asks: its open asks are all there is to answer, so the push they
 * made when they were put is its whole signal and a stop never names it again. The card agenda the daemon opened is
 * that; a ferret's thread is, until its ferret asks it something NEW (its turn with the owner starts after the asks).
 */
export const asksOnlyCardAsks = (
  item: Pick<AgendaItem, 'raisedBy' | 'sourceRef' | 'waitingSince'> & {
    readonly cardAsks?: readonly Pick<AgendaCardAsk, 'answer' | 'at'>[] | undefined;
  },
): boolean => {
  const open = (item.cardAsks ?? []).filter(isOpenCardAsk);
  if (open.length === 0) return false;
  if (item.raisedBy === 'daemon' && parseCardAgendaReference(item.sourceRef) !== undefined) return true;
  return Date.parse(item.waitingSince) <= Math.max(...open.map(ask => Date.parse(ask.at)));
};

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

/**
 * Whether an open agenda can carry a card's ask: a ferret's own item, or one the daemon raised on a ferret's behalf (the
 * card's own agenda, a Not good follow-up). Not a notice, a gate item from before card asks, nor an item that is
 * something else for the owner to do (an input, a confirmation, a copied plan, a task plan, a 2FA seed, a phone
 * approval, a sign-in rule). The ONE test the engine and the boot migration share.
 */
export const canCarryCardAsk = (
  item: Pick<
    AgendaItem,
    | 'notice'
    | 'gate'
    | 'kind'
    | 'confirms'
    | 'copyPlan'
    | 'taskPlan'
    | 'twoFactorSeed'
    | 'phoneApproval'
    | 'signInRuleSuggestion'
    | 'signInRuleSuspended'
    | 'raisedBy'
    | 'source'
    | 'sourceRef'
  >,
): boolean =>
  item.notice !== true &&
  item.gate === undefined &&
  item.kind !== 'input' &&
  item.confirms === undefined &&
  item.copyPlan === undefined &&
  item.taskPlan === undefined &&
  item.twoFactorSeed === undefined &&
  item.phoneApproval === undefined &&
  item.signInRuleSuggestion === undefined &&
  item.signInRuleSuspended === undefined &&
  (item.raisedBy === 'agent' ||
    (item.raisedBy === 'daemon' &&
      item.source === 'task' &&
      (parseCardAgendaReference(item.sourceRef) !== undefined ||
        parseGateFollowupReference(item.sourceRef) !== undefined)));

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
