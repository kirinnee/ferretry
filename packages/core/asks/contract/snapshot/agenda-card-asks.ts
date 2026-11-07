/**
 * CARD ASKS — the pure facts both ends read off `AgendaItem.cardAsks` (docs/agenda.md § Card asks): which asks are
 * open, which one an older app is shown, which card an agenda carries, the stage an ask puts it in, and the
 * reference of the agenda the daemon opens for a card nobody's agenda carries yet. Total.
 */
import type { AgendaCardAsk, AgendaGate, AgendaItem } from './agenda.ts';
import { gateReference, parseGateFollowupReference } from './agenda-gate.ts';
import { gateAskLine } from './agenda-gate-wording.ts';
import type { AgendaStage } from './agenda-state.ts';
import type { TaskRef } from './board-refs.ts';
import { canonicalJson } from '@ferretry/std';
import { sha256Hex } from './sha256.ts';

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

/** A card ask as the "does the item ask its own question" rule reads it: its gate and the How to test it carries. */
export interface CardAskWords {
  readonly gate: Pick<AgendaGate, 'options' | 'laneName' | 'cardTitle'>;
  readonly howToTest?: string | null | undefined;
}

/** The lane's own opening of a card ask's line (`gateAskLine` with nothing said): "Try it:", "OK to build?". */
const askLinePrefix = (gate: Pick<AgendaGate, 'options' | 'laneName'>): string => gateAskLine(gate, '').trim();

/**
 * Whether this is the card agenda the daemon opened with its ask still the one it generated: raised by the daemon under
 * a `card-agenda:` reference, an open question with no questions, fields or steps, and its subject still exactly the
 * one the daemon last wrote (`generatedSubject`): every card agenda is born with it. Only then is the item's whole ask
 * its card asks; once a ferret or the owner rewrites the subject, the item asks the owner something of its own. Never read
 * from the revision tail, which keeps only the newest few. The ONE test the daemon's state machine and the app share.
 */
export const isGeneratedCardAgendaAsk = (
  item: Pick<
    AgendaItem,
    'raisedBy' | 'sourceRef' | 'questions' | 'fields' | 'steps' | 'ask' | 'subject' | 'generatedSubject'
  > & {
    readonly cardAsks?: readonly Pick<AgendaCardAsk, 'gate' | 'howToTest'>[] | undefined;
  },
): boolean => {
  if (item.raisedBy !== 'daemon' || parseCardAgendaReference(item.sourceRef) === undefined) return false;
  if ((item.questions?.length ?? 0) > 0 || (item.fields?.length ?? 0) > 0 || (item.steps?.length ?? 0) > 0) {
    return false;
  }
  if (item.ask?.kind !== 'open-question') return false;
  return item.generatedSubject !== undefined && item.subject === item.generatedSubject;
};

/** A line as it is compared: no Markdown marks, one space between words, no closing stop, lower case. */
const collapsed = (text: string): string =>
  text
    .replaceAll(/[*_`#>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!]+$/u, '')
    .toLowerCase();

/** The lines of a How to test, each without its list marker: what a generated "Try it: <first step>" line can be. */
const stepLines = (text: string): readonly string[] =>
  text
    .split('\n')
    .map(line => collapsed(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')))
    .filter(line => line !== '');

/**
 * Whether an ask line only REPEATS one of these card asks, so the card ask's own block says it once: the lane's own
 * words (`gateAskLine`: "Try it: …", "OK to build? …") followed by nothing, the card's title, or one whole step of its
 * How to test (or that step's first sentence: the daemon clips the line there). Anything else — a ferret's question,
 * even one quoting a step — says something the card ask does not. Pure and total.
 */
export const askLineRepeatsCardAsk = (line: string, asks: readonly CardAskWords[]): boolean =>
  asks.some(ask => {
    const prefix = askLinePrefix(ask.gate);
    if (!line.startsWith(prefix)) return false;
    const rest = collapsed(line.slice(prefix.length));
    if (rest === '') return true;
    const title = ask.gate.cardTitle === undefined ? '' : collapsed(ask.gate.cardTitle);
    // A step may be cut at its first sentence (the daemon clips the line), never anywhere else.
    const step = (each: string): boolean => each === rest || each.startsWith(`${rest}. `);
    return rest === title || (typeof ask.howToTest === 'string' && stepLines(ask.howToTest).some(step));
  });

/**
 * Whether the item asks the owner a question of its OWN beside its card asks (docs/agenda.md § One ask): it has
 * questions, fields or steps, or its ask line (its subject, trimmed) says something — it is neither the daemon's
 * generated card agenda ask (`isGeneratedCardAgendaAsk`) nor a line that only repeats one of `asks`
 * (`askLineRepeatsCardAsk`). The app keeps that line on screen and lets typed words answer it, never the card; the
 * daemon keeps the item in Needs you after the card ask's answer until the owner answers it. The ONE rule both ends read.
 */
export const itemAsksOwnQuestion = (
  item: Parameters<typeof isGeneratedCardAgendaAsk>[0],
  asks: readonly CardAskWords[],
): boolean => {
  if ((item.questions?.length ?? 0) > 0 || (item.fields?.length ?? 0) > 0 || (item.steps?.length ?? 0) > 0) {
    return true;
  }
  // With no questions there is no single question to read: the ask line is the subject.
  const line = item.subject.trim();
  return line !== '' && !isGeneratedCardAgendaAsk(item) && !askLineRepeatsCardAsk(line, asks);
};

/**
 * The digest of the item's OWN ask as it now stands — its ask line (the subject, trimmed), questions, fields, steps,
 * ask and ask version — stored by the daemon as `ownAskRepliedTo` when the owner answers the item in words. Anything a
 * ferret does to the question (rewords it, adds a question or a field, re-asks it under the next version) changes it,
 * so a reply to an earlier question never answers a later one. `undefined` when it has no canonical spelling. The ONE
 * spelling both ends read: the daemon writes it and rests the item by it, the app reads it to know the question is answered.
 */
export const ownAskDigest = (
  item: Pick<AgendaItem, 'subject' | 'questions' | 'fields' | 'steps' | 'ask' | 'askVersion'>,
): string | undefined => {
  const spelled = canonicalJson({
    line: item.subject.trim(),
    ...(item.questions === undefined ? {} : { questions: item.questions }),
    ...(item.fields === undefined ? {} : { fields: item.fields }),
    ...(item.steps === undefined ? {} : { steps: item.steps }),
    ...(item.ask === undefined ? {} : { ask: item.ask }),
    version: item.askVersion ?? 1,
  });
  return spelled.ok ? sha256Hex(spelled.text).slice(0, 32) : undefined;
};

/** Whether the owner answered the item's own ask, as it now stands, in words (`ownAskRepliedTo`). */
export const repliedToOwnAsk = (
  item: Pick<AgendaItem, 'subject' | 'questions' | 'fields' | 'steps' | 'ask' | 'askVersion' | 'ownAskRepliedTo'>,
): boolean => item.ownAskRepliedTo !== undefined && item.ownAskRepliedTo === ownAskDigest(item);

/**
 * Whether the item still has an ask of its OWN for the owner, and no answer of theirs on it: a choice, yes/no,
 * permission, task or review that has no answer yet, or a question the item asks in its own words beside `asks`
 * (`itemAsksOwnQuestion`) that no reply has answered (`ownAskRepliedTo`, while the question stands unchanged). A notice,
 * and an item the owner has answered (`ownerAnswer`), ask nothing of their own. The ONE rule the daemon rests an item by
 * and the app reads to decide whether the item's own question or its card's try-it is the ask now: once this is false the
 * card ask takes over in the same item. Pure and total.
 */
export const awaitsOwnAnswer = (
  item: Parameters<typeof itemAsksOwnQuestion>[0] &
    Pick<AgendaItem, 'notice' | 'ownerAnswer' | 'ownAskRepliedTo' | 'askVersion'>,
  asks: readonly CardAskWords[],
): boolean => {
  if (item.notice === true || item.ownerAnswer !== undefined) return false;
  if (item.ask !== undefined && item.ask.kind !== 'open-question') return true;
  if (repliedToOwnAsk(item)) return false;
  return itemAsksOwnQuestion(item, asks);
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
 * The ONE ask of a card's own agenda — the agenda the daemon opened for the card, which asks the owner nothing else —
 * so its answer is the item's own: Good in one tap, anything else typed. `undefined` for any other item, and for a card
 * agenda that holds more or fewer than one open ask.
 */
export const ownCardAsk = (
  item: Pick<AgendaItem, 'raisedBy' | 'sourceRef'> & { readonly cardAsks?: readonly AgendaCardAsk[] | undefined },
): AgendaCardAsk | undefined => {
  if (item.raisedBy !== 'daemon' || parseCardAgendaReference(item.sourceRef) === undefined) return undefined;
  const open = openCardAsks(item);
  return open.length === 1 ? open[0] : undefined;
};

/**
 * An agenda's open card asks IN THE ORDER THEY ARE ASKED (docs/agenda.md § Card asks): every ask still waiting for an
 * answer first, as they were put on it; then the ones the owner said Not yet to, the one set aside longest ago first,
 * so the next ask is always reachable and saying Not yet again to the first of them brings the next one forward. Ties
 * keep the order the asks were put on. The ONE order the app draws, the mirror shows and an unnamed answer reaches.
 */
export const askedCardAsks = <Ask extends Pick<AgendaCardAsk, 'answer' | 'notYet'>>(item: {
  readonly cardAsks?: readonly Ask[] | undefined;
}): Ask[] => {
  const open = (item.cardAsks ?? []).filter(isOpenCardAsk);
  const deferredAt = (ask: Ask): number => {
    const at = Date.parse(ask.notYet?.at ?? '');
    return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
  };
  return [
    ...open.filter(ask => ask.notYet === undefined),
    ...open.filter(ask => ask.notYet !== undefined).sort((left, right) => deferredAt(left) - deferredAt(right)),
  ];
};

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
 * card's own agenda, a Not good follow-up). Not a notice, nor an item that is
 * something else for the owner to do (an input, a confirmation, a copied plan, a task plan, a 2FA seed, a phone
 * approval, a sign-in rule). The ONE test the engine and the app share.
 */
export const canCarryCardAsk = (
  item: Pick<
    AgendaItem,
    | 'notice'
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
