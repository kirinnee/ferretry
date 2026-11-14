import type { AskAnswer, AskDraft, AskId, AsksApi, AskSummary } from '@ferretry/core-asks/contract';
import type { EntryId, SourceKey } from '@ferretry/core-asks/contract';
import { type CardId, parseGateReference } from '../../contract/index.ts';
import type {
  AnsweredAsk,
  AskThread,
  BoardOptIn,
  BoardThreads,
  CardObligations,
  CardAskReader,
  GateAnswer,
  OpenCardAsk,
  OpenCardAskEntry,
} from '../lib/board/index.ts';

/** The Asks source this plugin registers: a card's gate entry is an obligation `{ source: 'card', ref, entry }`. */
export const CARD_SOURCE = 'card' as SourceKey;

const cardOf = (entry: string): CardId | undefined => parseGateReference(entry)?.cardId as CardId | undefined;

/**
 * The `card` source's obligations in Asks (#1552: the agenda asks, the card shows). `raise` is idempotent by
 * `(source, entry)`; `open` THROWS when Asks cannot be read, because "not asking" would let a second ask through.
 */
export class AsksCardObligations implements CardObligations {
  constructor(private readonly asks: Pick<AsksApi, 'raise' | 'open' | 'close' | 'answers'>) {}

  async raise(draft: AskDraft): Promise<boolean> {
    const entry = draft.entry as EntryId;
    const known = await this.asks.open({ source: CARD_SOURCE, entry });
    if (known.some(ask => ask.state !== 'closed')) return false;
    if ((await this.asks.answers({ source: CARD_SOURCE, entry })).length > 0) return false;
    await this.asks.raise(draft);
    return true;
  }

  async withdraw(entry: string, reason: 'withdrawn' | 'superseded'): Promise<void> {
    for (const ask of await this.asks.open({ source: CARD_SOURCE, entry: entry as EntryId, state: 'open' }))
      await this.asks.close({ ferret: ask.ferret ?? '', id: ask.id }, reason, entry as EntryId);
  }

  async open(card?: CardId): Promise<readonly OpenCardAskEntry[]> {
    const open = await this.asks.open({ source: CARD_SOURCE, state: 'open' });
    return open.flatMap(ask => {
      const cardId = cardOf(ask.entry);
      if (cardId === undefined || (card !== undefined && cardId !== card)) return [];
      return [{ entry: ask.entry, ask: ask.id, ferret: ask.ferret ?? '', cardId }];
    });
  }

  async answered(card: CardId): Promise<ReadonlySet<string>> {
    return (await this.answeredAll()).get(card) ?? new Set();
  }

  async openAll(): Promise<ReadonlyMap<CardId, readonly OpenCardAskEntry[]>> {
    const byCard = new Map<CardId, OpenCardAskEntry[]>();
    for (const entry of await this.open()) byCard.set(entry.cardId, [...(byCard.get(entry.cardId) ?? []), entry]);
    return byCard;
  }

  async answeredAll(): Promise<ReadonlyMap<CardId, ReadonlySet<string>>> {
    const byCard = new Map<CardId, Set<string>>();
    for (const answer of await this.asks.answers({ source: CARD_SOURCE })) {
      const cardId = cardOf(answer.entry);
      if (cardId === undefined) continue;
      byCard.set(cardId, (byCard.get(cardId) ?? new Set<string>()).add(answer.entry));
    }
    return byCard;
  }
}

/**
 * Every open ask of the `card` source, with the card its gate entry names, in ONE Asks read (`AsksApi.open`). Asks
 * links an ask to a card only through this source, so this is every ask a card can carry.
 */
export class AsksCardAskReader implements CardAskReader {
  constructor(private readonly asks: Pick<AsksApi, 'open'>) {}

  async open(): Promise<readonly OpenCardAsk[]> {
    const open = await this.asks.open({ source: CARD_SOURCE, state: 'open' });
    return open.flatMap(ask => {
      const cardId = cardOf(ask.entry);
      if (cardId === undefined || ask.ferret === undefined) return [];
      return [{ ferret: ask.ferret, id: ask.id, cardId, notice: ask.kind === 'notice' }];
    });
  }
}

/** The labels a kind of ask offers when it does not list them: a yes/no asks exactly Yes and No. */
const labelsOf = (ask: AskSummary): readonly string[] => (ask.kind === 'yesno' ? ['Yes', 'No'] : []);

/**
 * What the opt-in rule reads of an answered ask: who raised it, what it asked, and how it was answered. The summary
 * does not carry a choice's own labels (GAP), so only a yes/no reads as one.
 */
const answeredAsk = (ask: AskSummary, answer: AskAnswer | undefined): AnsweredAsk => ({
  raisedBy: ask.raisedBy.kind,
  ...(ask.raisedBy.kind === 'ferret' ? { raisedByFerret: ask.raisedBy.ferret } : {}),
  subject: ask.subject,
  options: labelsOf(ask),
  ...(answer === undefined
    ? {}
    : { answer: { by: 'owner' as const, ...(answer.choice === undefined ? {} : { choice: answer.choice }) } }),
});

export class AsksOptIn {
  constructor(private readonly asks: Pick<AsksApi, 'get' | 'answers'>) {}

  async answered(ferret: string, id: string): Promise<AnsweredAsk | undefined> {
    const ask = await this.asks.get({ ferret, id: id as AskId });
    if (ask === undefined || ask.state === 'open') return undefined;
    const answers = await this.asks.answers({ source: ask.source, entry: ask.entry });
    return answeredAsk(
      ask,
      answers.find(answer => answer.ask === ask.id),
    );
  }

  /** Composes the switch/name half (from the lanes) with the answered-ask half (from Asks). */
  with(board: Pick<BoardOptIn, 'isOn' | 'nameOf'>): BoardOptIn {
    return {
      isOn: async project => await board.isOn(project),
      nameOf: async project => await board.nameOf(project),
      answered: async (ferret, id) => await this.answered(ferret, id),
    };
  }
}

/**
 * The asks a card may be made to carry out (`fy card new --thread`). Asks has no way to link an ask to a card, so a
 * thread reads as open and unlinked and the link is refused in words (GAP: an Asks link would close it).
 */
export class AsksThreads implements BoardThreads {
  constructor(private readonly asks: Pick<AsksApi, 'get'>) {}

  async open(ferret: string, id: string): Promise<AskThread | undefined> {
    const ask = await this.asks.get({ ferret, id: id as AskId });
    if (ask === undefined || ask.state !== 'open') return undefined;
    return {
      raisedBy: ask.raisedBy.kind,
      ...(ask.raisedBy.kind === 'ferret' ? { raisedByFerret: ask.raisedBy.ferret } : {}),
      gate: ask.source === CARD_SOURCE,
      notice: ask.kind === 'notice',
      card: null,
    };
  }

  async link(): Promise<{ readonly ok: false; readonly message: string }> {
    return {
      ok: false,
      message: 'an ask cannot be linked to a card on this daemon yet; make the card without --thread',
    };
  }
}

/**
 * Shapes one answer Asks recorded for the gate (`GateItems.answer`). Answering is owner-only in Asks (a device or the
 * host), so `human` is always true; the host's own answer is recorded as the admin token, as it always was. `undefined`
 * when its ask can no longer be read.
 */
export const gateAnswerOf = async (asks: Pick<AsksApi, 'get'>, answer: AskAnswer): Promise<GateAnswer | undefined> => {
  const ask = await asks.get({ ferret: answer.ferret, id: answer.ask });
  if (ask === undefined) return undefined;
  return {
    answerId: answer.id,
    ask: { ferret: answer.ferret, id: answer.ask },
    entry: answer.entry,
    ...(answer.choice === undefined ? {} : { choice: answer.choice }),
    ...(answer.text === undefined ? {} : { text: answer.text }),
    human: answer.by.kind === 'host' || answer.by.kind === 'device',
    caller: answer.by.kind === 'host' ? { kind: 'owner', via: 'admin-token' } : { kind: 'owner' },
  };
};
