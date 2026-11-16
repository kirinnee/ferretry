/**
 * TIDY — the one decision behind `fy tidy`: which of a ferret's own cards to drop, which of its own asks to close, and
 * what to keep and why. Copied from today's `lib/tidy/plan.ts`.
 *
 * Pure. The service gathers the facts; this decides, so a dry run, the real run and the tests share one rule and
 * nothing here can write.
 *
 * A card is dropped only when it is the ferret's own errand on a board nobody switched on: the card is the ferret's
 * (owner or assignee), still open, asked by an agent, on a board that is off, assigned to no other live ferret and not
 * waiting at a gate on the owner. An ask is closed only when it is the ferret's own, raised by it, and only tracks
 * work; anything that asks the owner something is listed and left.
 *
 * What 5.0 changed: a card never asks (#1552), so an ask no longer carries a card link; `card-dropped` is therefore
 * never produced here, though the code stays in the wire. An ask is "being answered" once it is `answered` and not yet
 * closed, which is where today's pending-reply and undelivered flags ended up.
 */
import type { AskKind, AskRaiser } from '@ferretry/core-asks/contract';
import type { TidyClose, TidyDrop, TidyKeep, TidyPlan } from '../../contract/index.ts';

/** What the decision needs to know about one card. */
export interface TidyCardFact {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly owner: string;
  /** The ferret doing it; `null` means the owner ferret is. */
  readonly assignee: string | null;
  readonly askedBy: 'person' | 'agent';
}

/** What the decision needs to know about one ask. */
export interface TidyAskFact {
  readonly id: string;
  readonly subject: string;
  readonly kind: AskKind;
  readonly source: string;
  readonly raisedBy: AskRaiser;
  /** `answered`: the owner has answered and the answer is not applied yet. */
  readonly state: 'open' | 'answered';
}

export interface TidyFacts {
  readonly ferret: string;
  readonly helper: boolean;
  readonly cards: readonly TidyCardFact[];
  /** The projects whose board switch is on. An unreadable switch is off, so it is not in this set. */
  readonly boardsOn: ReadonlySet<string>;
  /** Ferrets still running, waiting or starting, not stopped. */
  readonly liveFerrets: ReadonlySet<string>;
  /** Cards an open gate ask waits on the owner for. */
  readonly gateCards: ReadonlySet<string>;
  /** The caller's own asks, open or answered. */
  readonly asks: readonly TidyAskFact[];
}

type CardKeep = Extract<TidyKeep, { kind: 'card' }>;
type AskKeep = Extract<TidyKeep, { kind: 'ask' }>;

const effectiveAssignee = (card: TidyCardFact): string => card.assignee ?? card.owner;

/** The first reason a card must stay, or `undefined` when it is the ferret's own unwanted card. */
const cardKeep = (card: TidyCardFact, facts: TidyFacts): CardKeep | undefined => {
  const keep = (code: CardKeep['code'], why: string): CardKeep => ({
    kind: 'card',
    id: card.id,
    title: card.title,
    code,
    why,
  });
  if (card.askedBy === 'person') return keep('owner-asked', 'the owner asked for it');
  if (facts.boardsOn.has(card.project)) return keep('board-on', 'the board is on, so the card is wanted');
  const doing = effectiveAssignee(card);
  if (doing !== facts.ferret && facts.liveFerrets.has(doing))
    return keep('assigned-to-live-ferret', `${doing} is still working it`);
  if (facts.gateCards.has(card.id)) return keep('waiting-at-gate', 'it waits at a gate on the owner');
  return undefined;
};

/** Whether an ask wants the owner to decide something (anything but a notice or a plain work-tracking task). */
const asksOwner = (ask: TidyAskFact): boolean => ask.kind !== 'notice' && ask.kind !== 'task';

const closes = (ask: TidyAskFact, code: TidyClose['code'], why: string): TidyClose => ({
  id: ask.id as TidyClose['id'],
  subject: ask.subject,
  code,
  why,
});

const keepsAsk = (ask: TidyAskFact, code: AskKeep['code'], why: string): TidyKeep => ({
  kind: 'ask',
  id: ask.id as AskKeep['id'],
  title: ask.subject,
  code,
  why,
});

type AskVerdict = { readonly close: TidyClose } | { readonly keep: TidyKeep };

const judgeAsk = (ask: TidyAskFact, facts: TidyFacts): AskVerdict => {
  if (ask.source === 'card' || ask.raisedBy.kind === 'daemon')
    return { keep: keepsAsk(ask, 'gate', 'the daemon raised it for a card gate; the owner answers it') };
  if (ask.raisedBy.kind !== 'ferret' || ask.raisedBy.ferret !== facts.ferret)
    return { keep: keepsAsk(ask, 'not-yours', 'you did not raise it') };
  if (ask.state === 'answered') return { keep: keepsAsk(ask, 'owner-replying', 'the owner is answering it now') };
  if (asksOwner(ask))
    return {
      keep: keepsAsk(ask, 'needs-owner', `it asks the owner; close it by hand with fy ask (${ask.id})`),
    };
  if (ask.kind === 'notice') return { close: closes(ask, 'notice', 'it only informs; nothing to decide') };
  return { close: closes(ask, 'status-only', 'it asks no question and offers no choice; it only tracks work') };
};

/** Decide a ferret's tidy. Cards and asks are independent lists; a helper's plan has no cards. */
export const planTidy = (facts: TidyFacts): TidyPlan => {
  const keep: TidyKeep[] = [];
  const drop: TidyDrop[] = [];
  const candidates = facts.helper
    ? []
    : facts.cards.filter(card => card.owner === facts.ferret || card.assignee === facts.ferret);
  for (const card of candidates) {
    const reason = cardKeep(card, facts);
    if (reason === undefined)
      drop.push({
        id: card.id,
        title: card.title,
        why: 'the board is off and nobody but you asked for it',
      });
    else keep.push(reason);
  }
  const close: TidyClose[] = [];
  for (const ask of facts.asks) {
    const verdict = judgeAsk(ask, facts);
    if ('close' in verdict) close.push(verdict.close);
    else keep.push(verdict.keep);
  }
  return { ferret: facts.ferret as TidyPlan['ferret'], helper: facts.helper, drop, close, keep };
};
