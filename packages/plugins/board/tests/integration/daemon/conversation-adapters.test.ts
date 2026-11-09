import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { SpawnOptions, SpawnResult } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import type { CardView } from '../../../contract/index.ts';
import { GhSpawnRunner, GitSpawnCopies, KEPT_FOR_MS } from '../../../daemon/adapters/github.ts';
import { ConversationMessages, sendIdOf } from '../../../daemon/adapters/messages.ts';
import { ConversationOwnerWords } from '../../../daemon/adapters/owner-words.ts';
import { BoardReferenceCatalog } from '../../../daemon/adapters/reference-catalog.ts';
import { BoardWorkSource, cardWork } from '../../../daemon/adapters/work-source.ts';
import { card, lanes, PROJECT } from '../../unit/board/support.ts';

const spawned = (stdout = '', exitCode: number | null = 0, stderr = ''): SpawnResult => ({
  exitCode,
  signal: null,
  stdout,
  stderr,
});

describe('the host’s own gh, run as a child', () => {
  const runner = (run: (program: string, args: readonly string[], options?: SpawnOptions) => Promise<SpawnResult>) =>
    new GhSpawnRunner({ run }, fixedClock(), 5_000);

  test('a gh that exits 0 hands its output on, never prompting and carrying no token in its environment', async () => {
    let options: SpawnOptions | undefined;
    const outcome = await runner(async (_program, _args, given) => {
      options = given;
      return spawned('{"data":1}');
    }).run(['api', 'graphql']);

    expect(outcome).toEqual({ kind: 'ok', stdout: '{"data":1}' });
    expect(options?.env).toEqual({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' });
  });

  test('a gh that cannot start is missing, and the sign-in exit or words are unauthenticated with only the first line', async () => {
    expect(
      await runner(async () => {
        throw new Error('ENOENT');
      }).run([]),
    ).toEqual({ kind: 'missing' });
    expect(
      await runner(async () => spawned('', 4, 'To get started with GitHub CLI, run: gh auth login\nmore')).run([]),
    ).toEqual({
      kind: 'unauthenticated',
      detail: 'To get started with GitHub CLI, run: gh auth login',
    });
    expect(await runner(async () => spawned('', 1, 'You are not logged in to any hosts')).run([])).toMatchObject({
      kind: 'unauthenticated',
    });
  });

  test('any other failure carries the first line gh printed, or its exit when it printed none, and what it had said so far', async () => {
    expect(await runner(async () => spawned('part', 1, 'HTTP 502\ndetails')).run([])).toEqual({
      kind: 'failed',
      detail: 'HTTP 502',
      stdout: 'part',
    });
    expect(await runner(async () => spawned('', 3)).run([])).toEqual({
      kind: 'failed',
      detail: 'gh exited 3',
      stdout: '',
    });
    expect(await runner(async () => ({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' })).run([])).toEqual({
      kind: 'failed',
      detail: 'gh exited SIGKILL',
      stdout: '',
    });
  });

  test('a gh that runs past its deadline is killed and reported failed whether the spawn exits or rejects, passing nothing on', async () => {
    for (const rejects of [false, true]) {
      const clock = fixedClock();
      const timed = new GhSpawnRunner(
        {
          run: async (_program, _args, options) =>
            await new Promise<SpawnResult>((resolve, reject) => {
              options?.signal?.addEventListener('abort', () =>
                rejects
                  ? reject(new Error('aborted'))
                  : resolve({ exitCode: null, signal: 'SIGTERM', stdout: 'partial', stderr: '' }),
              );
            }),
        },
        clock,
        5_000,
      );

      const outcome = timed.run(['api']);
      await clock.advance(5_000);

      expect(await outcome).toEqual({ kind: 'failed', detail: 'gh took longer than 5000 ms', stdout: '' });
      expect(clock.pending()).toBe(0);
    }
  });
});

describe('git asked about a working copy', () => {
  const rig = (answers: Record<string, SpawnResult | 'throw'> = {}) => {
    const asked: string[] = [];
    const clock = { ms: 0 };
    const copies = new GitSpawnCopies(
      {
        run: async (program, args) => {
          const line = [program, ...args].join(' ');
          asked.push(line);
          const answer = Object.entries(answers).find(([key]) => line.includes(key))?.[1];
          if (answer === 'throw') throw new Error('git is not installed');
          return answer ?? spawned('');
        },
      },
      { nowMs: () => clock.ms },
    );
    return { asked, clock, copies };
  };

  test('an https origin on GitHub names its repository; a local path, another host or no origin names none', async () => {
    const world = rig({
      '/gh remote': spawned('https://github.com/kirinnee/ferretry.git\n'),
      '/other remote': spawned('https://gitlab.com/o/r.git\n'),
      '/local remote': spawned('/srv/git/ferretry.git\n'),
    });

    expect(await world.copies.repositoryOf('/gh')).toBe('kirinnee/ferretry');
    expect(await world.copies.repositoryOf('/other')).toBeNull();
    expect(await world.copies.repositoryOf('/local')).toBeNull();
    expect(await world.copies.repositoryOf('/none')).toBeNull();
  });

  test('an ssh alias is resolved once with ssh -G to the host it really goes to, and a failed ssh falls back to the alias', async () => {
    const world = rig({
      '/a remote': spawned('git@work-gh:kirinnee/ferretry.git\n'),
      '/b remote': spawned('git@work-gh:kirinnee/other.git\n'),
      '/c remote': spawned('git@dead-alias:kirinnee/third.git\n'),
      '-G work-gh': spawned('user git\nhostname github.com\nport 22\n'),
      '-G dead-alias': 'throw',
    });

    expect(await world.copies.repositoryOf('/a')).toBe('kirinnee/ferretry');
    expect(await world.copies.repositoryOf('/b')).toBe('kirinnee/other');
    expect(await world.copies.repositoryOf('/c')).toBeNull();
    expect(world.asked.filter(line => line.includes('ssh -G work-gh'))).toHaveLength(1);
  });

  test('an ssh alias whose answer names no hostname stays the alias, and a direct ssh github.com origin needs no ssh -G', async () => {
    const world = rig({
      '/a remote': spawned('git@someplace:o/r.git\n'),
      '/b remote': spawned('git@github.com:o/r2.git\n'),
      '-G someplace': spawned('user git\nport 22\n'),
    });

    expect(await world.copies.repositoryOf('/a')).toBeNull();
    expect(await world.copies.repositoryOf('/b')).toBe('o/r2');
    expect(world.asked.some(line => line.includes('ssh -G github.com'))).toBe(false);
  });

  test('the branch is the one HEAD names under refs/heads; a detached HEAD, another ref or a git that cannot run is none', async () => {
    const world = rig({
      '/main symbolic-ref': spawned('refs/heads/feat/x\n'),
      '/odd symbolic-ref': spawned('refs/remotes/origin/main\n'),
      '/broken symbolic-ref': 'throw',
    });

    expect(await world.copies.branchOf('/main')).toBe('feat/x');
    expect(await world.copies.branchOf('/odd')).toBeNull();
    expect(await world.copies.branchOf('/detached')).toBeNull();
    expect(await world.copies.branchOf('/broken')).toBeNull();
  });

  test('an answer is shared within a tick, forgotten by the next, and a null answer is asked again at once', async () => {
    const world = rig({ '/main symbolic-ref': spawned('refs/heads/main\n') });
    const asks = () => world.asked.filter(line => line.includes('/main symbolic-ref')).length;

    await world.copies.branchOf('/main');
    world.clock.ms += KEPT_FOR_MS - 1;
    await world.copies.branchOf('/main');
    expect(asks()).toBe(1);
    world.clock.ms += 1;
    await world.copies.branchOf('/main');
    expect(asks()).toBe(2);

    await world.copies.branchOf('/missing');
    await world.copies.branchOf('/missing');
    expect(world.asked.filter(line => line.includes('/missing symbolic-ref'))).toHaveLength(2);
  });

  test('a question already being asked is joined, not asked twice at once', async () => {
    const release: (() => void)[] = [];
    let asks = 0;
    const copies = new GitSpawnCopies(
      {
        run: async () => {
          asks += 1;
          await new Promise<void>(resolve => release.push(resolve));
          return spawned('refs/heads/main\n');
        },
      },
      { nowMs: () => 0 },
    );

    const both = Promise.all([copies.branchOf('/main'), copies.branchOf('/main')]);
    await Promise.resolve();
    for (const resolve of release) resolve();

    expect(await both).toEqual(['main', 'main']);
    expect(asks).toBe(1);
  });

  test('the folders it keeps answers for are bounded: the oldest is forgotten when too many are held', async () => {
    const world = rig({ symbolic: spawned('refs/heads/main\n') });
    for (let folder = 0; folder < 513; folder += 1) await world.copies.branchOf(`/f${String(folder)}`);
    const before = world.asked.length;

    await world.copies.branchOf('/f512');
    expect(world.asked.length).toBe(before);
    await world.copies.branchOf('/f0');
    expect(world.asked.length).toBe(before + 1);
  });
});

describe('Board’s messages through Conversation', () => {
  const FERRET = ferretId('f1');
  const over = (
    conversation: ConversationApi | undefined,
    leadOf: (ferret: string) => Promise<string | undefined> = async () => undefined,
  ) => {
    const warned: string[] = [];
    const ferrets = new FakeFerrets();
    ferrets.add({ id: FERRET, mode: 'auto' });
    return {
      warned,
      messages: new ConversationMessages(
        () => conversation,
        ferrets,
        { leadOf, addressOf: async id => id },
        { warn: m => warned.push(m) },
      ),
    };
  };
  const sending = (disposition: string | 'refuse' | 'throw'): ConversationApi =>
    ({
      send: async () => {
        if (disposition === 'throw') throw new Error('queue is full');
        if (disposition === 'refuse') return { ok: false, error: { code: 'invalid', message: 'not today' } };
        return { ok: true, value: { disposition } };
      },
    }) as unknown as ConversationApi;

  test('what Conversation did with a send is read as delivered, resumed or held', async () => {
    expect(await over(sending('sent')).messages.deliver('f1', 'hi', 'k1')).toBe('delivered');
    expect(await over(sending('revived')).messages.deliver('f1', 'hi', 'k1')).toBe('resumed');
    expect(await over(sending('queued-for-revive')).messages.deliver('f1', 'hi', 'k1')).toBe('held');
  });

  test('a refused send, a send that throws, or no ferret to send to is absent, said in the log; Conversation off holds the message', async () => {
    const refused = over(sending('refuse'));
    expect(await refused.messages.deliver('f1', 'hi', 'k1')).toBe('absent');
    expect(refused.warned[0]).toContain('was refused: not today');
    const thrown = over(sending('throw'));
    expect(await thrown.messages.deliver('f1', 'hi', 'k1')).toBe('absent');
    expect(thrown.warned[0]).toContain('was not sent: queue is full');
    const notAnError = over({ send: async () => Promise.reject('plain text') } as unknown as ConversationApi);
    await notAnError.messages.deliver('f1', 'hi', 'k1');
    expect(notAnError.warned[0]).toContain('plain text');
    expect(await over(fakeConversation(), async () => 'not a ferret id!').messages.deliver('f1', 'hi', 'k1')).toBe(
      'absent',
    );
    const off = over(undefined);
    expect(await off.messages.deliver('f1', 'hi', 'k1')).toBe('absent');
    expect(off.warned[0]).toContain('Conversation is off');
  });

  test('the owner’s files go with a message only where they already are, else the message says they could not be copied', async () => {
    const conversation = fakeConversation();
    const { messages } = over(conversation);

    await messages.deliver('f1', 'with files', 'k-same', { from: FERRET, ids: ['a1', 'a2'] } as never);
    await messages.deliver('f1', 'one file', 'k-other', { from: ferretId('f2'), ids: ['a1'] } as never);
    await messages.deliver('f1', 'many files', 'k-many', { from: ferretId('f2'), ids: ['a1', 'a2'] } as never);

    const texts = (await conversation.sends(FERRET)).sends.map(send => send.sendId);
    expect(texts).toEqual(['k-same', 'k-other', 'k-many']);
  });

  test('a helper’s message goes to its lead, a plain send and a withheld alert are logged, and the mode is read from Ferrets', async () => {
    const conversation = fakeConversation();
    const { messages, warned } = over(conversation, async ferret => (ferret === 'f1' ? 'f1' : undefined));

    await messages.send('f1', 'nudge', 'k1');
    await messages.withheld('f1', 'an alert');

    expect((await conversation.sends(FERRET)).sends.map(send => send.sendId)).toEqual(['k1']);
    expect(warned).toEqual(['a board alert for f1 was held back (the ferret is interactive): an alert']);
    expect(await messages.mode('f1')).toBe('auto');
    expect(await messages.mode('ghost')).toBeUndefined();
    expect(await messages.mode('not a ferret id!')).toBeUndefined();
  });

  test('the transcript tail is read, unresolved when the ferret is unknown to Conversation, and unreadable on any other failure', async () => {
    const reading = (result: unknown) =>
      over({ transcriptEvents: async () => result } as unknown as ConversationApi).messages;

    expect(await reading({ ok: true, value: { events: [] } }).tail('f1', 5)).toEqual({ kind: 'read', events: [] });
    expect(await reading({ ok: false, error: { code: 'not_found', message: 'x' } }).tail('f1', 5)).toEqual({
      kind: 'unresolved',
    });
    expect(await reading({ ok: false, error: { code: 'unreadable', message: 'x' } }).tail('f1', 5)).toEqual({
      kind: 'unreadable',
    });
    const throwing = over({
      transcriptEvents: async () => {
        throw new Error('io');
      },
    } as unknown as ConversationApi).messages;
    expect(await throwing.tail('f1', 5)).toEqual({ kind: 'unreadable' });
  });

  test('a key Conversation takes as an id is the send id, any other key is named by its digest', () => {
    expect(sendIdOf('board-reopen-F1-4')).toBe('board-reopen-F1-4');
    expect(sendIdOf('has space')).toMatch(/^board-[0-9a-f]{48}$/u);
  });
});

describe('what the owner said to a ferret, read for the board', () => {
  test('a best-effort read answers nobody spoke when Conversation is off, the id is no ferret or Conversation refuses', async () => {
    const refusing = {
      ownerWords: async () => ({ ok: false as const, error: { code: 'unreadable', message: 'damaged' } }),
    };

    expect(await new ConversationOwnerWords(() => undefined).said('f1')).toEqual([]);
    expect(await new ConversationOwnerWords(() => fakeConversation()).said('not a ferret id!')).toEqual([]);
    expect(await new ConversationOwnerWords(() => refusing as never).said('f1')).toEqual([]);
  });

  test('a strict read says why it could not read instead of reading as nobody spoke', async () => {
    const refusing = {
      ownerWords: async () => ({ ok: false as const, error: { code: 'unreadable', message: 'damaged' } }),
    };

    await expect(new ConversationOwnerWords(() => undefined).said('f1', { strict: true })).rejects.toThrow(
      'Conversation is off',
    );
    await expect(
      new ConversationOwnerWords(() => fakeConversation()).said('not a ferret id!', { strict: true }),
    ).rejects.toThrow('not a ferret id');
    await expect(new ConversationOwnerWords(() => refusing as never).said('f1', { strict: true })).rejects.toThrow(
      'damaged',
    );
  });

  test('the words are what Conversation says the owner sent', async () => {
    const conversation = fakeConversation();
    await conversation.send(ferretId('f1'), { kind: 'owner' }, { message: 'build the board' });

    expect(await new ConversationOwnerWords(() => conversation).said('f1')).toEqual(['build the board']);
  });
});

const view = (over: Partial<ReturnType<typeof card>> = {}, touched: string | null = null): CardView => ({
  ...card(over),
  lastTouchedAt: touched,
  touchedBy: null,
  activity: 'idle',
  rollup: {
    children: 0,
    byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
    active: 0,
    lastTouchedAt: null,
  },
  suggestedLane: null,
  openAsks: [],
  blockedBy: [],
  blocks: [],
  shippedIn: null,
});

describe('the & menu of one ferret’s composer', () => {
  const catalog = (views: readonly CardView[], withLanes = true) =>
    new BoardReferenceCatalog({
      sweepBoard: async () => ({ views, laneSets: withLanes ? new Map([[PROJECT, lanes()]]) : new Map() }),
    });
  const asking = (query?: string) => ({ ferret: 'f1', ...(query === undefined ? {} : { query }), caller: {} });

  test('it lists the cards the ferret owns or is assigned, open and active work first, closed work known but marked', async () => {
    const dropped = {
      ...view({ id: 'F5', owner: 'f1' }),
      dropped: { reason: 'no', at: '2026-11-02T00:00:00.000Z', by: { kind: 'owner' } },
    } as CardView;
    const entries = await catalog([
      view(
        { id: 'F1', owner: 'f1', laneId: 'todo', assignee: 'helper', summary: 'green badge' },
        '2026-11-01T10:00:00.000Z',
      ),
      view({ id: 'F2', owner: 'lead', assignee: 'f1', laneId: 'implement' }, '2026-10-01T10:00:00.000Z'),
      view({ id: 'F3', owner: 'f1', laneId: 'closed' }),
      view({ id: 'F4', owner: 'other', assignee: 'other' }),
      dropped,
    ]).entries(asking());

    expect(entries.map(entry => entry.token)).toEqual(['F2', 'F1', 'F3', 'F5']);
    expect(entries[1]).toMatchObject({ detail: 'helper', aliases: ['Todo', 'green badge'] });
    expect(entries.filter(entry => entry.closed === true).map(entry => entry.token)).toEqual(['F3', 'F5']);
  });

  test('who asked for a card is read from the card’s own facts and the query narrows by words, ignoring case', async () => {
    const entries = await catalog([
      view({ id: 'F1', owner: 'f1', title: 'Badge colour', askedBy: 'person' } as never),
      view({ id: 'F2', owner: 'f1', title: 'Inbox', origin: 'agent' } as never),
      view({ id: 'F3', owner: 'f1', title: 'Other', askedBy: 'agent' } as never),
      view({
        id: 'F4',
        owner: 'f1',
        title: 'Humanly',
        origin: 'human',
        createdBy: { kind: 'ferret', name: 'x', ferret: 'x' },
      } as never),
      view({ id: 'F6', owner: 'f1', title: 'By a ferret', createdBy: { kind: 'ferret', name: 'x', ferret: 'x' } }),
      view({ id: 'F7', owner: 'f1', title: 'By the owner' }),
    ]).entries(asking());

    const agentAsked = (token: string) => entries.find(entry => entry.token === token)?.agentAsked;
    expect(agentAsked('F1')).toBeUndefined();
    expect(agentAsked('F2')).toBe(true);
    expect(agentAsked('F3')).toBe(true);
    expect(agentAsked('F4')).toBeUndefined();
    expect(agentAsked('F6')).toBe(true);
    expect(
      (await catalog([view({ id: 'F1', owner: 'f1', title: 'Badge colour' })]).entries(asking('BADGE'))).length,
    ).toBe(1);
    expect(await catalog([view({ id: 'F1', owner: 'f1' })]).entries(asking('nothing matches'))).toEqual([]);
  });

  test('a card on a board whose lanes cannot be read stands as open under its lane id, with no alias an empty summary', async () => {
    const entries = await catalog([view({ id: 'F1', owner: 'f1', laneId: '', summary: '' })], false).entries(asking());

    expect(entries).toEqual([{ token: 'F1', label: 'Board store', detail: 'unassigned', agentAsked: true }]);
  });

  test('equal cards keep a steady order by when they were touched and then by id', async () => {
    const entries = await catalog([
      view({ id: 'F9', owner: 'f1', createdAt: 'not a date' }),
      view({ id: 'F2', owner: 'f1', createdAt: 'not a date' }),
    ]).entries(asking());

    expect(entries.map(entry => entry.token)).toEqual(['F2', 'F9']);
  });
});

describe('Board’s cards as work for the search', () => {
  const cardOf = (over: Parameters<typeof card>[0] = {}) => card(over);

  test('a card is open, closed in a closed lane or dropped, with its standing, its notes and its progress as fields', () => {
    const base = cardOf({
      id: 'F1',
      progress: { now: 'writing', doneSoFar: 'plan', next: 'test' } as never,
      clarifications: [{ text: 'which green?' }] as never,
      history: [
        { seq: 1, at: '2026-10-30T10:00:00.000Z', actor: { kind: 'owner' }, type: 'created', laneId: 'todo' },
        { seq: 2, at: '2026-10-31T10:00:00.000Z', actor: { kind: 'owner' }, type: 'note', text: 'a note' },
      ] as never,
    });
    const set = lanes();

    const open = cardWork(base, set);
    const closed = cardWork({ ...base, laneId: 'closed' }, set);
    const dropped = cardWork(
      { ...base, dropped: { reason: 'no', at: '2026-11-02T00:00:00.000Z', by: { kind: 'owner' } } as never },
      set,
    );
    const lost = cardWork({ ...base, laneId: 'mystery' }, undefined);

    expect(open.identity).toMatchObject({ state: 'open', standing: 'Todo' });
    expect(closed.identity).toMatchObject({ state: 'closed', standing: 'Closed' });
    expect(dropped.identity).toMatchObject({ state: 'dropped', standing: 'Dropped' });
    expect(lost.identity).toMatchObject({ state: 'open', standing: 'mystery' });
    expect(Object.fromEntries(open.fields)).toMatchObject({ note: 'a note', progress: 'writing\nplan\ntest' });
    expect(Object.fromEntries(open.fields).ask).toContain('which green?');
    expect(open.updatedAtMs).toBe(Date.parse('2026-10-31T10:00:00.000Z'));
    expect(cardWork({ ...base, history: [], createdAt: 'nonsense' }, set).updatedAtMs).toBe(0);
    expect(Object.fromEntries(cardWork(cardOf({ id: 'F2' }), set).fields).progress).toBe('');
  });

  test('a card that did not change is handed over as the same object, one that did as a new one, and a gone one is dropped', async () => {
    let cards = [cardOf({ id: 'F1' }), cardOf({ id: 'F2' })];
    const source = new BoardWorkSource({ snapshot: async () => ({ cards, laneSets: new Map([[PROJECT, lanes()]]) }) });

    const first = await source.list();
    cards = [cardOf({ id: 'F1' }), cardOf({ id: 'F2', title: 'Renamed' })];
    const second = await source.list();
    cards = [cardOf({ id: 'F1' })];
    const third = await source.list();

    expect(source.id).toBe('board');
    expect(second[0]).toBe(first[0]!);
    expect(second[1]).not.toBe(first[1]!);
    expect(third.map(work => work.key)).toEqual(['card:F1']);
  });
});
