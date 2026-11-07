import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { StatePort } from '@ferretry/kernel/contract';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_STATE, ConversationPort, type QueuedMessage } from '../../../../contract/index.ts';
import daemon from '../../../../daemon/index.ts';
import { StateSendLedger } from '../../../../daemon/delivery/adapters/index.ts';
import { StateQueueStore } from '../../../../daemon/queue/adapters/index.ts';
import { parseSessionId } from '../../../../daemon/seams/ferret-id.ts';
import {
  NO_TURN_DOCUMENTS,
  OwnerWordsReader,
  ownerPartOf,
  type TurnDocument,
} from '../../../../daemon/turns/lib/owner-words.ts';
import { memoryStatePort } from '../../../support/state.ts';

const ID = parseSessionId('lead');
const AT = '2026-11-07T09:00:00.000Z' as Instant;

const queued = (overrides: Partial<QueuedMessage>): QueuedMessage => ({
  v: 1,
  id: 'm1',
  sender: 'human',
  text: 'build the board',
  attachmentIds: [],
  enqueuedAt: AT,
  state: 'read',
  stateAt: AT,
  revision: 1,
  ...overrides,
});

const reader = (
  sources: {
    queue?: readonly QueuedMessage[] | Error;
    sends?: readonly object[] | Error;
    turns?: readonly TurnDocument[] | Error;
    startedByFerret?: boolean | Error;
  } = {},
) =>
  new OwnerWordsReader({
    queue: {
      list: async () => {
        if (sources.queue instanceof Error) throw sources.queue;
        return sources.queue ?? [];
      },
    },
    sends: {
      list: async () => {
        if (sources.sends instanceof Error) throw sources.sends;
        return (sources.sends ?? []) as never;
      },
    },
    turns: {
      list: async () => {
        if (sources.turns instanceof Error) throw sources.turns;
        return sources.turns ?? [];
      },
    },
    startedByFerret: async () => {
      if (sources.startedByFerret instanceof Error) throw sources.startedByFerret;
      return sources.startedByFerret ?? false;
    },
  });

describe('F-0001 who wrote each turn: a turn document is the owner’s only as far as its author record says', () => {
  test('F-0001 a document whose author record names the owner is the owner’s words', async () => {
    const words = await reader({ turns: [{ turn: 2, text: 'ship it\n', by: { kind: 'owner' } }] }).said(ID);
    expect(words).toEqual(['ship it']);
  });

  test('F-0001 a document whose author record names a ferret or Ferretry is nobody’s words of the owner', async () => {
    const words = await reader({
      turns: [
        { turn: 2, text: 'a peer wrote this', by: { kind: 'ferret', name: 'lead' } },
        { turn: 3, text: 'a notice', by: { kind: 'ferretry', feature: 'board' } },
      ],
    }).said(ID);
    expect(words).toEqual([]);
  });

  test('F-0001 a document with no author record is the owner’s, less the paragraphs Ferretry wrote', async () => {
    const words = await reader({
      turns: [{ turn: 4, text: '[board] you changed code\n\nplease also add tests' }],
    }).said(ID);
    expect(words).toEqual(['please also add tests']);
  });

  test('F-0001 a document wrapped as a ferret’s message is not the owner’s even with no author record', async () => {
    expect(await reader({ turns: [{ turn: 2, text: '[message from ferret x] hi' }] }).said(ID)).toEqual([]);
  });

  test('F-0001 the first turn of a ferret another ferret started is that ferret’s brief, not the owner’s', async () => {
    const turns: TurnDocument[] = [
      { turn: 1, text: 'the brief' },
      { turn: 2, text: 'the owner steps in', by: { kind: 'owner' } },
    ];
    expect(await reader({ turns, startedByFerret: true }).said(ID)).toEqual(['the owner steps in']);
    expect(await reader({ turns, startedByFerret: false }).said(ID)).toEqual(['the brief', 'the owner steps in']);
  });

  test('F-0001 a turn a send started is read from the ledger, which says who sent it, not from its document', async () => {
    const words = await reader({
      sends: [{ senderKind: 'daemon', message: 'a nudge', turn: 3 }],
      turns: [{ turn: 3, text: 'a nudge' }],
    }).said(ID);
    expect(words).toEqual([]);
  });
});

describe('the owner’s words from the queue and the send ledger', () => {
  test('a person’s queued message is the owner’s; one a ferret or Ferretry sent is not', async () => {
    const words = await reader({
      queue: [
        queued({ id: 'a', text: 'mine' }),
        queued({ id: 'b', text: 'a ferret', sender: 'agent' }),
        queued({ id: 'c', text: 'a notice', by: { kind: 'ferretry', feature: 'warden' } }),
        queued({ id: 'd', text: 'also mine', by: { kind: 'owner' } }),
      ],
    }).said(ID);
    expect(words).toEqual(['mine', 'also mine']);
  });

  test('a person’s send with no sending ferret is the owner’s; a peer’s is not; the same words count once', async () => {
    const words = await reader({
      queue: [queued({ text: 'build the board' })],
      sends: [
        { message: 'build the board', turn: 1 },
        { message: 'from a peer', from: 'f2', turn: 2 },
        { message: 'from the daemon', senderKind: 'daemon', turn: 3 },
        { message: 'and then this', senderKind: 'human', turn: 4 },
      ],
    }).said(ID);
    expect(words).toEqual(['build the board', 'and then this']);
  });

  test('ownerPartOf drops a ferret’s message whole and Ferretry’s notices by paragraph', () => {
    expect(ownerPartOf('[reply from ferret a] ok')).toBeNull();
    expect(ownerPartOf('The Warden stopped you.\n\nkeep going')).toBe('keep going');
    expect(ownerPartOf('[answer to !A3] yes')).toBe('[answer to !A3] yes');
  });

  test('no turn documents are written yet, so the words come from the queue and the ledger alone', async () => {
    const words = await new OwnerWordsReader({
      queue: { list: async () => [queued({ text: 'only this' })] },
      sends: { list: async () => [] },
      turns: NO_TURN_DOCUMENTS,
      startedByFerret: async () => false,
    }).said(ID, { strict: true });
    expect(words).toEqual(['only this']);
  });
});

describe('a strict read never takes "nothing could be read" for "nobody spoke"', () => {
  const broken = new Error('unreadable');
  for (const source of ['queue', 'sends', 'turns', 'startedByFerret'] as const) {
    test(`a strict read fails when the ${source} cannot be read; a best-effort one answers with the rest`, async () => {
      const sources = { queue: [queued({ text: 'kept' })], [source]: broken };
      await expect(reader(sources).said(ID, { strict: true })).rejects.toThrow('unreadable');
      expect(await reader(sources).said(ID)).toEqual(source === 'queue' ? [] : ['kept']);
    });
  }
});

describe('Conversation’s port answers what the owner said', () => {
  async function conversation(state: StatePort = memoryStatePort(CONVERSATION_STATE), readable = true) {
    const ferrets = new FakeFerrets();
    if (readable) ferrets.add({ id: ferretId('lead'), state: 'working' });
    const implementation = {
      ...daemon,
      build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
        const build = daemon.build;
        if (build === undefined) throw new Error('no build');
        return build({ ...ctx, kernel: { ...ctx.kernel, state } });
      },
    } as typeof daemon;
    const host = await testHost({
      plugins: [implementation],
      fakes: { ferrets, asks: new FakeAsks() },
      clock: fixedClock('2026-11-07T09:00:00Z'),
    });
    return { host, state, api: () => host.provided(ConversationPort) };
  }

  test('F-0001 the words are the queue’s and the ledger’s, and the answer is the contract’s', async () => {
    const { host, state, api } = await conversation();
    await new StateQueueStore(state).append(ID, {
      v: 1,
      kind: 'enqueued',
      at: AT,
      message: queued({ text: 'build the board', state: 'queued' }),
    });
    await new StateSendLedger(state, { now: () => AT }).accept(ID, {
      sendId: 's1',
      acceptedAt: AT,
      acceptedTurn: 1,
      path: 'direct',
      message: 'and add tests',
      fate: 'delivered',
    });

    const said = await api().ownerWords(ferretId('lead'), { strict: true });

    expect(said).toEqual({
      ok: true,
      value: { v: 1, ferret: ferretId('lead'), words: ['build the board', 'and add tests'] },
    });
    await host.stop();
  });

  test('F-0001 a strict read of a ferret that cannot be read is refused, where a best-effort one says nobody spoke', async () => {
    const { host, api } = await conversation(undefined, false);
    const strict = await api().ownerWords(ferretId('lead'), { strict: true });
    expect(strict).toMatchObject({ ok: false, error: { code: 'unreadable' } });
    expect(await api().ownerWords(ferretId('lead'))).toMatchObject({ ok: true, value: { words: [] } });
    await host.stop();
  });
});
