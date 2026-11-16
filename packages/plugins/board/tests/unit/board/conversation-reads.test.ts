import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import type { RawWork, TranscriptEvent, WorkSource } from '@ferretry/plugin-conversation/contract';
import type { Instant } from '@ferretry/std';
import { ConversationMessages, sendIdOf } from '../../../daemon/adapters/messages.ts';
import { ConversationOwnerWords } from '../../../daemon/adapters/owner-words.ts';
import { BoardWorkSource, cardWork } from '../../../daemon/adapters/work-source.ts';
import { BoardTurnCheck, boardCheckSendId, mutatingWork, raisesAsk } from '../../../daemon/lib/board/index.ts';
import { createdPrUrls } from '../../../daemon/lib/github/transcript.ts';
import { as, boot, makeCard } from '../../integration/daemon/harness.ts';

/**
 * What Board takes from Conversation's additive reads (lead-approved): the send id, the transcript tail with tool calls,
 * the owner's words, and `search.sources`.
 */

const F1 = ferretId('f1');
const AT = '2026-11-07T09:00:00.000Z' as Instant;
/** Long enough for the match: the owner's words count from 24 letters and digits. */
const ASK = 'Please make the badge colour green on every page of the website.';
const stamp = { timestamp: AT } as const;

const messagesOver = (conversation = fakeConversation()) => {
  const warnings: string[] = [];
  const ferrets = new FakeFerrets();
  ferrets.add({ id: F1 });
  const messages = new ConversationMessages(() => conversation, ferrets, { leadOf: async () => undefined } as never, {
    warn: message => warnings.push(message),
  });
  return { conversation, messages, warnings };
};

describe('Board sends with the key as the send id: the same message is one message across runs', () => {
  test('a reopen delivered twice by two runs of Board is typed once, and the second answers as the first did', async () => {
    const conversation = fakeConversation();
    const firstRun = messagesOver(conversation).messages;
    const secondRun = messagesOver(conversation).messages;

    const first = await firstRun.deliver('f1', 'The owner reopened &F1', 'board-reopen-F1-4');
    const again = await secondRun.deliver('f1', 'The owner reopened &F1', 'board-reopen-F1-4');

    expect([first, again]).toEqual(['delivered', 'delivered']);
    const sends = (await conversation.sends(F1)).sends;
    expect(sends.map(send => send.sendId)).toEqual(['board-reopen-F1-4']);
  });

  test('nothing is remembered in Board: the dedupe is Conversation’s, so a message it does not hold is sent', async () => {
    const { conversation, messages } = messagesOver();

    await messages.deliver('f1', 'one', 'board-check-f1-1');
    await messages.deliver('f1', 'two', 'board-check-f1-2');

    expect((await conversation.sends(F1)).sends.map(send => send.sendId)).toEqual([
      'board-check-f1-1',
      'board-check-f1-2',
    ]);
  });

  test('a key that is not a usable send id is named by its digest, the same one every time', () => {
    const long = `board-done-${Array.from({ length: 40 }, (_, index) => `F${index}-9`).join('+')}`;
    expect(sendIdOf('board-reopen-F1-4')).toBe('board-reopen-F1-4');
    expect(sendIdOf(long)).toMatch(/^board-[0-9a-f]{48}$/u);
    expect(sendIdOf(long)).toBe(sendIdOf(long));
    expect(sendIdOf(`${long}x`)).not.toBe(sendIdOf(long));
    expect(sendIdOf('has space')).toMatch(/^board-[0-9a-f]{48}$/u);
  });

  test('a done message whose key names many cards is still one message, however long the key', async () => {
    const { conversation, messages } = messagesOver();
    const key = `board-done-${Array.from({ length: 40 }, (_, index) => `F${index}-9`).join('+')}`;

    await messages.deliver('f1', 'all done', key);
    await messages.deliver('f1', 'all done', key);

    expect((await conversation.sends(F1)).sends).toHaveLength(1);
  });
});

const events: readonly TranscriptEvent[] = [
  { kind: 'message', role: 'user', text: 'open the PR', ...stamp },
  {
    kind: 'tool-call',
    role: 'assistant',
    ...stamp,
    call: { id: 'toolu_1', name: 'Bash', input: { command: 'git commit -am fix && gh pr create --fill' } },
  },
  {
    kind: 'tool-result',
    role: 'tool',
    ...stamp,
    result: {
      callId: 'toolu_1',
      content: 'https://github.com/o/r/pull/7',
      text: 'https://github.com/o/r/pull/7',
      isError: false,
    },
  },
  { kind: 'message', role: 'assistant', text: 'opened it', ...stamp },
];

describe('Board reads the tool calls of a turn through Conversation’s transcript tail', () => {
  test('the tail carries the tool calls and results, so a PR a ferret opened is linked from its transcript', async () => {
    const { conversation, messages } = messagesOver();
    conversation.setEvents(F1, events);

    const tail = await messages.tail('f1', 400);

    expect(tail.kind).toBe('read');
    if (tail.kind !== 'read') return;
    expect(tail.events.map(event => event.kind)).toEqual(['message', 'tool-call', 'tool-result', 'message']);
    expect(createdPrUrls(tail.events)).toEqual(['https://github.com/o/r/pull/7']);
  });

  test('the turn-end check sees the mutating work of the last turn and nudges a ferret with no card', async () => {
    const { conversation, messages } = messagesOver();
    conversation.setEvents(F1, events);
    const sent: { sendId: string; message: string }[] = [];
    const check = new BoardTurnCheck(
      {
        readable: async () => true,
        boardOn: async () => true,
        tail: async (ferret, limit) => {
          const read = await messages.tail(ferret, limit);
          return read.kind === 'read' ? read.events : [];
        },
        focus: { focusOf: async () => null, skipOf: async () => null },
        card: async () => {
          throw new Error('no card');
        },
        send: async (_ferret, sendId, message) => void sent.push({ sendId, message }),
        record: async () => undefined,
        now: () => 1_000,
      },
      'fy',
    );

    expect(await check.check('f1')).toBe(true);
    expect(sent.map(each => each.sendId)).toEqual([boardCheckSendId('f1', 1_000)]);
    const tail = await messages.tail('f1', 400);
    expect(tail.kind === 'read' ? mutatingWork(tail.events, 'fy') : []).toEqual(['git commit', 'gh pr create']);
  });

  test('the gate check sees a ferret’s own raising of an ask in its tool calls', async () => {
    const { conversation, messages } = messagesOver();
    conversation.setEvents(F1, [
      { kind: 'message', role: 'user', text: 'go', ...stamp },
      {
        kind: 'tool-call',
        role: 'assistant',
        ...stamp,
        call: { id: 't2', name: 'mcp__ferretry__terminal_ask_owner', input: {} },
      },
    ]);
    const tail = await messages.tail('f1', 400);
    expect(tail.kind === 'read' && tail.events.some(raisesAsk)).toBe(true);
  });

  test('a ferret with no transcript Conversation can prove is its own is unresolved, and with Conversation off too', async () => {
    const off = new ConversationMessages(
      () => undefined,
      new FakeFerrets(),
      { leadOf: async () => undefined } as never,
      { warn: () => undefined },
    );
    expect(await off.tail('f1', 10)).toEqual({ kind: 'unresolved' });
    expect(await messagesOver().messages.tail('not an id', 10)).toEqual({ kind: 'unresolved' });
  });
});

describe('F-0001 Board reads the owner’s words through Conversation, strictly for a ferret’s private choice', () => {
  test('F-0001 the words are what Conversation says the owner sent', async () => {
    const conversation = fakeConversation();
    await conversation.send(F1, { kind: 'owner' }, { message: 'build the board' });
    await conversation.send(F1, { kind: 'ferret', ferret: ferretId('f2') }, { message: 'from a peer' });

    const words = await new ConversationOwnerWords(() => conversation).said('f1', { strict: true });

    expect(words).toEqual(['build the board']);
  });

  test('F-0001 a strict read with Conversation off, or refusing, throws; a best-effort one says nobody spoke', async () => {
    const off = new ConversationOwnerWords(() => undefined);
    await expect(off.said('f1', { strict: true })).rejects.toThrow('Conversation is off');
    expect(await off.said('f1')).toEqual([]);

    const refusing = new ConversationOwnerWords(() => ({
      ownerWords: async () => ({ ok: false as const, error: { code: 'unreadable', message: 'a record is damaged' } }),
    }));
    await expect(refusing.said('f1', { strict: true })).rejects.toThrow('a record is damaged');
    expect(await refusing.said('f1')).toEqual([]);
  });

  /** A card a ferret made on its own account, carrying words the owner may or may not have said to it. */
  const ferretCard = async (world: Awaited<ReturnType<typeof boot>>, text: string) => {
    await world.host.request('PUT', '/v1/board/projects/unfiled/switch', { body: { on: true }, headers: as('owner') });
    const made = await world.host.request('POST', '/v1/board/cards', {
      body: { kind: 'feature', title: 'Badge colour', assignee: 'f1', ask: { text, source: 'session:f1' } },
      headers: as('ferret:f1'),
    });
    expect(made.status).toBe(200);
    return made.json<{ card: { id: string } }>().card.id;
  };
  const hide = async (world: Awaited<ReturnType<typeof boot>>, id: string) =>
    await world.host.request('POST', `/v1/board/cards/${id}`, {
      body: { action: 'visibility', visibility: 'private' },
      headers: as('ferret:f1'),
    });

  test('F-0001 a ferret hiding a card whose ask the owner said to it is told no, through the whole daemon', async () => {
    const conversation = fakeConversation();
    const world = await boot({ uses: { conversation } });
    await conversation.send(F1, { kind: 'owner' }, { message: ASK });
    const id = await ferretCard(world, ASK);

    const refused = await hide(world, id);

    expect(refused.status).toBe(403);
  });

  test('F-0001 a ferret’s private choice on a card the owner did not ask for is not refused', async () => {
    const conversation = fakeConversation();
    const world = await boot({ uses: { conversation } });
    await conversation.send(F1, { kind: 'owner' }, { message: 'Something unrelated entirely.' });
    const id = await ferretCard(world, ASK);

    expect((await hide(world, id)).status).toBe(200);
  });

  test('F-0001 with Conversation off, a ferret’s private choice is an unavailable board, never a guess', async () => {
    const world = await boot();
    const id = await ferretCard(world, ASK);

    expect((await hide(world, id)).status).toBe(503);
  });
});

describe('J-0091 Board hands its cards to Conversation’s work search through search.sources', () => {
  test('J-0091 the half contributes one source, “board”, whose list is every card as work', async () => {
    const world = await boot({ uses: { conversation: fakeConversation() } });
    const made = await makeCard(world.host);

    const [contribution] = world.contribution('search.sources') as { id: string; item: WorkSource }[];
    const works = await contribution?.item.list();

    expect(contribution?.id).toBe('board');
    expect(contribution?.item.id).toBe('board');
    expect(works?.map(work => work.key)).toEqual([`card:${made.id}`]);
    expect(works?.[0]).toMatchObject({
      kind: 'card',
      identity: { kind: 'card', id: made.id, title: 'Badge colour', ferret: 'f1', state: 'open' },
    });
    expect(works?.[0]?.fields.map(([field]) => field)).toContain('ask');
  });

  test('J-0091 a card that did not change is handed over as the same object, one that did as a new one, and a gone one is dropped', async () => {
    const world = await boot({ uses: { conversation: fakeConversation() } });
    const made = await makeCard(world.host);
    const [contribution] = world.contribution('search.sources') as { item: WorkSource }[];
    const first = (await contribution?.item.list()) as readonly RawWork[];
    const same = (await contribution?.item.list()) as readonly RawWork[];
    expect(same[0]).toBe(first[0] as RawWork);

    await world.host.request('POST', `/v1/board/cards/${made.id}`, {
      body: { action: 'note', text: 'the colour is #0a0' },
      headers: as('owner'),
    });
    const changed = (await contribution?.item.list()) as readonly RawWork[];
    expect(changed[0]).not.toBe(first[0] as RawWork);
    expect(changed[0]?.fields.find(([field]) => field === 'note')?.[1]).toContain('#0a0');
  });

  test('J-0091 a card’s searchable fields are the text the owner reads on it, and only those', () => {
    const work = cardWork(
      {
        id: 'F7',
        projectId: 'p1',
        laneId: 'doing',
        owner: 'f1',
        title: 'Badge',
        summary: 'green',
        ask: { text: 'make it green', source: 'owner' },
        clarifications: [{ text: 'not lime' }],
        premise: '',
        context: 'ctx',
        brief: 'plan',
        howToTest: 'look',
        progress: { now: 'painting', doneSoFar: '', next: 'ship' },
        dropped: null,
        createdAt: AT,
        history: [{ type: 'note', text: 'a note', at: AT }],
      } as never,
      undefined,
    );
    expect(work.fields).toEqual([
      ['id', 'F7'],
      ['title', 'Badge'],
      ['summary', 'green'],
      ['ask', 'make it green\nnot lime'],
      ['premise', ''],
      ['context', 'ctx'],
      ['brief', 'plan'],
      ['howToTest', 'look'],
      ['progress', 'painting\nship'],
      ['note', 'a note'],
    ]);
    expect(work.identity).toMatchObject({ standing: 'doing', state: 'open', project: 'p1', ferret: 'f1' });
  });

  test('J-0091 a source over an empty board lists nothing', async () => {
    expect(await new BoardWorkSource({ snapshot: async () => ({ cards: [], laneSets: new Map() }) }).list()).toEqual(
      [],
    );
  });
});
