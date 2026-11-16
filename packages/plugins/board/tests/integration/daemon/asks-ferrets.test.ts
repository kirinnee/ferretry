import { describe, expect, test } from 'bun:test';
import { entryId, FakeAsks, sourceKey } from '@ferretry/core-asks/contract/testing';
import type { AskDraft } from '@ferretry/core-asks/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { gateReference } from '../../../contract/index.ts';
import {
  AsksCardObligations,
  AsksCardAskReader,
  AsksOptIn,
  AsksThreads,
  CARD_SOURCE,
  gateAnswerOf,
} from '../../../daemon/adapters/asks.ts';
import { FerretsHelpers, FerretsLiveness, FerretsNames, FerretsParents } from '../../../daemon/adapters/ferrets.ts';
import { CardAskLinks } from '../../../daemon/lib/board/index.ts';
import { KeyedSerial } from '../../../daemon/lib/lanes/serial.ts';
import { card } from '../../support/board.ts';

const gate = (cardId: string, entry = 1) => gateReference({ cardId, laneId: 'plan', entry });

const gateDraft = (cardId: string, entry = 1, ferret = 'f1'): AskDraft => ({
  source: CARD_SOURCE,
  ref: {},
  entry: entryId(gate(cardId, entry)),
  kind: 'yesno',
  subject: `Approve the plan for ${cardId}`,
  why: 'the plan waits for you',
  raisedBy: { kind: 'daemon' },
  ferret,
});

describe('a card gate as an obligation in Asks', () => {
  test('withdrawing a gate names its entry to Asks, so a carrier holding other gates keeps them', async () => {
    const asks = new FakeAsks();
    const obligations = new AsksCardObligations(asks);
    await obligations.raise(gateDraft('F1'));
    const closes: { entry: unknown; reason: unknown }[] = [];
    const recording = {
      raise: asks.raise.bind(asks),
      answers: asks.answers.bind(asks),
      open: asks.open.bind(asks),
      close: async (
        ref: Parameters<typeof asks.close>[0],
        reason: Parameters<typeof asks.close>[1],
        entry?: unknown,
      ) => {
        closes.push({ entry, reason });
        await asks.close(ref, reason);
      },
    };

    await new AsksCardObligations(recording as never).withdraw(gate('F1'), 'withdrawn');

    expect(closes).toEqual([{ entry: gate('F1'), reason: 'withdrawn' }]);
  });

  test('raising the same gate entry twice is one ask, and an entry already answered is never asked again', async () => {
    const asks = new FakeAsks();
    const obligations = new AsksCardObligations(asks);

    expect(await obligations.raise(gateDraft('F1'))).toBe(true);
    expect(await obligations.raise(gateDraft('F1'))).toBe(false);
    const [raised] = await asks.open({ source: CARD_SOURCE });
    asks.answerAs({ ferret: 'f1', id: raised!.id }, 'approve');

    expect(await obligations.raise(gateDraft('F1'))).toBe(false);
    expect(await obligations.answered('F1' as never)).toEqual(new Set([gate('F1')]));
  });

  test('the open gates are listed with the card each names, optionally for one card, and other asks are left out', async () => {
    const asks = new FakeAsks();
    const obligations = new AsksCardObligations(asks);
    await obligations.raise(gateDraft('F1'));
    await obligations.raise(gateDraft('F2', 1, 'f2'));
    await asks.raise({ ...gateDraft('F3'), entry: entryId('not-a-gate') });

    const all = await obligations.open();
    const one = await obligations.open('F2' as never);

    expect(all.map(entry => entry.cardId).sort()).toEqual(['F1', 'F2']);
    expect(one).toEqual([{ entry: gate('F2'), ask: expect.any(String), ferret: 'f2', cardId: 'F2' }]);
  });

  test('every open gate is grouped under the card it names, and a card with two gates holds both', async () => {
    const asks = new FakeAsks();
    const obligations = new AsksCardObligations(asks);
    await obligations.raise(gateDraft('F1', 1));
    await obligations.raise(gateDraft('F1', 2));
    await obligations.raise(gateDraft('F2', 1, 'f2'));
    await asks.raise({ ...gateDraft('F3'), entry: entryId('not-a-gate') });

    const byCard = await obligations.openAll();

    expect([...byCard.keys()].sort()).toEqual(['F1', 'F2']);
    expect(byCard.get('F1' as never)?.map(entry => entry.entry)).toEqual([gate('F1', 1), gate('F1', 2)]);
    expect(byCard.get('F2' as never)?.map(entry => entry.ferret)).toEqual(['f2']);
  });

  test('withdrawing a gate closes its open ask, for the reason given, and leaves other gates open', async () => {
    const asks = new FakeAsks();
    const obligations = new AsksCardObligations(asks);
    await obligations.raise(gateDraft('F1'));
    await obligations.raise(gateDraft('F2', 1, 'f2'));

    await obligations.withdraw(gate('F1'), 'withdrawn');

    expect((await obligations.open()).map(entry => entry.cardId)).toEqual(['F2']);
  });
});

describe('the open card asks, read for the cards they are about', () => {
  test('every ledger’s gate asks name their card in one read; a plain ask and a notice from another source are left out', async () => {
    const asks = new FakeAsks();
    await new AsksCardObligations(asks).raise(gateDraft('F1'));
    await asks.raise({
      source: sourceKey('ferret'),
      ref: {},
      entry: entryId('e1'),
      kind: 'notice',
      subject: 'FYI',
      why: 'for your information',
      raisedBy: { kind: 'ferret', ferret: 'f1' },
      ferret: 'f1',
    });
    await new AsksCardObligations(asks).raise(gateDraft('F2', 1, 'f2'));
    await asks.raise({ ...gateDraft('F3'), entry: entryId('not-a-gate') });
    const reader = new AsksCardAskReader(asks);

    const open = await reader.open();

    expect(open.map(ask => ({ ferret: ask.ferret, cardId: ask.cardId, notice: ask.notice }))).toEqual([
      { ferret: 'f1', cardId: 'F1', notice: false },
      { ferret: 'f2', cardId: 'F2', notice: false },
    ]);
  });
});

describe('the asks a card carries, through the real Asks reader', () => {
  test('a card shows the gate ask on its ferret’s ledger and on a ledger outside its board, and an answered one is gone', async () => {
    const asks = new FakeAsks();
    const obligations = new AsksCardObligations(asks);
    await obligations.raise(gateDraft('F1', 1, 'owner'));
    await obligations.raise(gateDraft('F1', 2, 'stranger'));
    await obligations.raise(gateDraft('F2', 1, 'helper'));
    await asks.raise({ ...gateDraft('F1'), entry: entryId('not-a-gate') });
    const links = new CardAskLinks(new AsksCardAskReader(asks), { warn: () => undefined });
    const cards = [card({ id: 'F1', owner: 'owner' }), card({ id: 'F2', owner: 'owner', assignee: 'helper' })];

    const found = await links.asksFor(cards);

    expect(found.get('F1')?.open.map(ref => ref.ferret)).toEqual(['owner', 'stranger']);
    expect(found.get('F1')?.asking).toEqual(found.get('F1')?.open ?? []);
    expect(found.get('F2')?.open.map(ref => ref.ferret)).toEqual(['helper']);
    const [first] = found.get('F1')?.open ?? [];
    asks.answerAs({ ferret: first!.ferret, id: first!.id as never }, 'approve');
    expect((await links.asksFor(cards)).get('F1')?.open.map(ref => ref.ferret)).toEqual(['stranger']);
  });
});

describe('the opt-in rule’s reading of an answered ask', () => {
  const raise = async (asks: FakeAsks, raisedBy: AskDraft['raisedBy'], kind: AskDraft['kind'] = 'yesno') =>
    await asks.raise({
      source: sourceKey('ferret'),
      ref: {},
      entry: entryId(`e-${raisedBy.kind}-${kind}`),
      kind,
      subject: 'Use the board for this project?',
      why: 'a question',
      raisedBy,
      ferret: 'f1',
    });

  test('an ask that is unknown or still open reads as nothing', async () => {
    const asks = new FakeAsks();
    const optIn = new AsksOptIn(asks);
    const open = await raise(asks, { kind: 'ferret', ferret: 'f1' });

    expect(await optIn.answered('f1', 'A99')).toBeUndefined();
    expect(await optIn.answered('f1', open.id)).toBeUndefined();
  });

  test('a yes/no a ferret raised and the owner answered reads with its labels and the choice', async () => {
    const asks = new FakeAsks();
    const ref = await raise(asks, { kind: 'ferret', ferret: 'f1' });
    asks.answerAs(ref, 'choose', { kind: 'host' }, { choice: 'Yes' });

    expect(await new AsksOptIn(asks).answered('f1', ref.id)).toEqual({
      raisedBy: 'ferret',
      raisedByFerret: 'f1',
      subject: 'Use the board for this project?',
      options: ['Yes', 'No'],
      answer: { by: 'owner', choice: 'Yes' },
    });
  });

  test('an ask the daemon raised that closed with no answer reads without one, and a non-yes/no has no labels', async () => {
    const asks = new FakeAsks();
    const ref = await raise(asks, { kind: 'daemon' }, 'task');
    await asks.close(ref, 'withdrawn');

    expect(await new AsksOptIn(asks).answered('f1', ref.id)).toEqual({
      raisedBy: 'daemon',
      subject: 'Use the board for this project?',
      options: [],
    });
  });

  test('an answer without a choice reads as an owner answer with no choice', async () => {
    const asks = new FakeAsks();
    const ref = await raise(asks, { kind: 'owner' });
    asks.answerAs(ref, 'done');

    expect((await new AsksOptIn(asks).answered('f1', ref.id))?.answer).toEqual({ by: 'owner' });
  });

  test('composed with the board’s switch and name, the rule reads all three halves', async () => {
    const asks = new FakeAsks();
    const ref = await raise(asks, { kind: 'ferret', ferret: 'f1' });
    asks.answerAs(ref, 'choose', { kind: 'host' }, { choice: 'No' });
    const composed = new AsksOptIn(asks).with({ isOn: async project => project === 'p1', nameOf: async () => 'Badge' });

    expect(await composed.isOn('p1' as never)).toBe(true);
    expect(await composed.nameOf('p1' as never)).toBe('Badge');
    expect((await composed.answered('f1', ref.id))?.answer).toEqual({ by: 'owner', choice: 'No' });
  });
});

describe('the asks a card may be made to carry out', () => {
  const raise = async (asks: FakeAsks, source: string, kind: AskDraft['kind'], raisedBy: AskDraft['raisedBy']) =>
    await asks.raise({
      source: sourceKey(source),
      ref: {},
      entry: entryId(`${source}-${kind}`),
      kind,
      subject: 'Do it',
      why: 'because',
      raisedBy,
      ferret: 'f1',
    });

  test('only an open ask is a thread, described by who raised it, and linking one is refused in words', async () => {
    const asks = new FakeAsks();
    const threads = new AsksThreads(asks);
    const byFerret = await raise(asks, 'ferret', 'task', { kind: 'ferret', ferret: 'f1' });
    const byDaemon = await raise(asks, 'card', 'notice', { kind: 'daemon' });
    const closed = await raise(asks, 'other', 'task', { kind: 'owner' });
    await asks.close(closed, 'withdrawn');

    expect(await threads.open('f1', byFerret.id)).toEqual({
      raisedBy: 'ferret',
      raisedByFerret: 'f1',
      gate: false,
      notice: false,
      card: null,
    });
    expect(await threads.open('f1', byDaemon.id)).toEqual({ raisedBy: 'daemon', gate: true, notice: true, card: null });
    expect(await threads.open('f1', closed.id)).toBeUndefined();
    expect(await threads.open('f1', 'A99')).toBeUndefined();
    expect(await threads.link()).toEqual({ ok: false, message: expect.stringContaining('cannot be linked') });
  });
});

describe('the answer Asks recorded for a gate', () => {
  test('is shaped with the choice and words, as the owner’s, and is nothing once its ask is gone', async () => {
    const asks = new FakeAsks();
    await new AsksCardObligations(asks).raise(gateDraft('F1'));
    const [open] = await asks.open({ source: CARD_SOURCE });
    const ref = { ferret: 'f1', id: open!.id };
    asks.answerAs(ref, 'choose', { kind: 'host' }, { choice: 'Yes', text: 'ship it' });
    asks.answerAs(ref, 'done', { kind: 'device', holder: 'dev_a' });
    const [byHost, byDevice] = await asks.answers({ source: CARD_SOURCE });

    expect(await gateAnswerOf(asks, byHost!)).toMatchObject({
      ask: ref,
      entry: gate('F1'),
      choice: 'Yes',
      text: 'ship it',
      human: true,
      caller: { kind: 'owner', via: 'admin-token' },
    });
    const device = await gateAnswerOf(asks, byDevice!);
    expect(device).toMatchObject({ human: true, caller: { kind: 'owner' } });
    expect(device).not.toHaveProperty('choice');
    expect(device).not.toHaveProperty('text');
    expect(await gateAnswerOf(asks, { ...byHost!, ask: 'A99' as never })).toBeUndefined();
  });
});

describe('the ferrets as the board’s one liveness read', () => {
  const world = () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('lead'), name: 'Lead One' });
    ferrets.add({ id: ferretId('helper'), parent: ferretId('lead') });
    return ferrets;
  };

  test('parents, helpers and names read from Ferrets and fall back to the id for a ferret it does not know', async () => {
    const ferrets = world();

    expect(await new FerretsParents(ferrets).parentOf('helper')).toBe('lead');
    expect(await new FerretsParents(ferrets).parentOf('ghost')).toBeUndefined();
    const helpers = new FerretsHelpers(ferrets);
    expect(await helpers.leadOf('helper')).toBe('lead');
    expect(await helpers.leadOf('ghost')).toBeUndefined();
    expect(await helpers.addressOf('lead')).toBe('Lead One');
    expect(await helpers.addressOf('ghost')).toBe('ghost');
    expect(await new FerretsNames(ferrets).nameOf('lead')).toBe('Lead One');
    expect(await new FerretsNames(ferrets).nameOf('ghost')).toBe('ghost');
  });

  test('a lookup that fails reads as an unknown ferret instead of failing the board', async () => {
    const failing = {
      get: async () => {
        throw new Error('ferrets are down');
      },
    };

    expect(await new FerretsHelpers(failing).leadOf('lead')).toBeUndefined();
    expect(await new FerretsHelpers(failing).addressOf('lead')).toBe('lead');
    expect(await new FerretsNames(failing).nameOf('lead')).toBe('lead');
  });

  test('the roster carries each ferret’s state, lead and focus card, and a focus that cannot be read is no card', async () => {
    const ferrets = world();
    ferrets.setState(ferretId('helper'), 'working');
    const focus = { focusOfAll: async () => new Map([['lead', { id: 'F1' } as never]]) };
    const liveness = new FerretsLiveness(ferrets, focus, new KeyedSerial());

    const roster = await liveness.roster();

    expect([...roster.held].sort()).toEqual(['helper', 'lead']);
    expect(roster.sessions.get('lead')).toMatchObject({ id: 'lead', status: 'idle', focusCard: { id: 'F1' } });
    expect(roster.sessions.get('lead')).not.toHaveProperty('lead');
    expect(roster.sessions.get('helper')).toMatchObject({ status: 'working', focusCard: null, lead: 'lead' });

    // A focus file that cannot be read at all is no card for anyone, and the roster still stands.
    const damaged = new FerretsLiveness(
      ferrets,
      { focusOfAll: async () => Promise.reject(new Error('damaged')) },
      new KeyedSerial(),
    );
    expect((await damaged.roster()).sessions.get('lead')).toMatchObject({ focusCard: null });
  });

  test('settled reads the named ferrets fresh inside one section, skipping those that cannot be read', async () => {
    const ferrets = world();
    const liveness = new FerretsLiveness(ferrets, { focusOfAll: async () => new Map() }, new KeyedSerial());

    const seen = await liveness.settled(['lead', 'ghost'], async fresh => [...fresh.held]);

    expect(seen).toEqual(['lead']);
    const throwing = new FerretsLiveness(
      {
        list: ferrets.list.bind(ferrets),
        get: async () => {
          throw new Error('ferrets are down');
        },
      },
      { focusOfAll: async () => new Map() },
      new KeyedSerial(),
    );
    expect(await throwing.settled(['lead'], async fresh => fresh.held.size)).toBe(0);
  });
});
