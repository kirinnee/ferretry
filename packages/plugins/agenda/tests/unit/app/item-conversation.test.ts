import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '../../../app/shell.ts';
import {
  conversationClientOf,
  type ItemConversationClient,
  itemSince,
  readItemConversation,
} from '../../../app/lib/item-conversation.ts';

const row = (offset: number, role: string, text: string, timestamp?: string) => ({
  point: `p${offset}`,
  role,
  text,
  selectionBinding: 'x',
  ...(timestamp === undefined ? {} : { timestamp }),
});
type Row = ReturnType<typeof row>;

interface Fake extends ItemConversationClient {
  readonly tails: { through?: string | undefined; limit?: number | undefined }[];
}

/** A daemon with `rows` as its whole conversation, paged backward by `messagesTail`. */
const daemonOf = (rows: readonly Row[]): Fake => {
  const tails: Fake['tails'] = [];
  return {
    tails,
    messagesTail: async (_session: string, tail: { through?: string; limit?: number } = {}) => {
      tails.push({ through: tail.through, limit: tail.limit });
      const end = tail.through === undefined ? rows.length : Number(tail.through);
      const start = Math.max(0, end - (tail.limit ?? 200));
      return {
        messages: rows.slice(start, end),
        nextCursor: null,
        previousCursor: start === 0 ? null : String(start),
      } as never;
    },
  } as never;
};

const filler = (from: number, count: number, stamp: (n: number) => string): Row[] =>
  Array.from({ length: count }, (_, n) =>
    row(from + n, n % 2 === 0 ? 'user' : 'assistant', `chatter ${from + n}`, stamp(from + n)),
  );

describe('readItemConversation', () => {
  const rows = [
    row(1, 'user', 'unrelated'),
    row(2, 'assistant', 'Asking about ^A4', '2026-08-01T10:00:00.000Z'),
    row(3, 'user', 'reply ^A4: ship it', '2026-08-01T10:05:00.000Z'),
    row(4, 'developer', '^A4 hidden'),
    row(5, 'assistant', 'Shipped.'),
    row(6, 'user', 'about ^A40'),
    row(7, 'assistant', 'not about it'),
  ];
  const expected = [
    ['assistant', 'Asking about ^A4'],
    ['user', 'reply ^A4: ship it'],
    ['assistant', 'Shipped.'],
  ];

  it('keeps the rows that name the item, and the ferret’s answer to the owner’s, across pages, oldest first', async () => {
    const client = daemonOf(rows);
    const entries = await readItemConversation(client, 'sess', 'A4');
    expect(entries.map(entry => [entry.kind, entry.text])).toEqual(expected);
    expect(entries[1]?.at).toBe(Date.parse('2026-08-01T10:05:00.000Z'));
  });
  it('reloads once without old cursor evidence when tail history goes stale', async () => {
    const fake = daemonOf(rows);
    const cursors: unknown[] = [];
    let reads = 0;
    const serve = async (cursor: string | undefined) => {
      cursors.push(cursor);
      reads += 1;
      if (reads === 2) throw new FyHttpError(409, 'old cursor', 'message_cursor_stale');
      return {
        messages: reads === 1 ? [row(999, 'user', 'obsolete ^A4')] : rows,
        nextCursor: reads === 1 ? 'old-cursor' : null,
        previousCursor: reads === 1 ? 'old-cursor' : null,
      } as never;
    };
    const client = {
      ...fake,
      messagesTail: async (_id: string, options?: { through?: string }) => serve(options?.through),
    };
    const entries = await readItemConversation(client, 'sess', 'A4');
    expect(entries.map(entry => [entry.kind, entry.text])).toEqual(expected);
    expect(cursors).toEqual([undefined, 'old-cursor', undefined]);
  });

  it('surfaces a second stale refusal instead of retrying forever', async () => {
    let reads = 0;
    const client = {
      ...daemonOf([]),
      messagesTail: async () => {
        reads += 1;
        throw new FyHttpError(409, 'still stale', 'message_cursor_stale');
      },
    };
    await expect(readItemConversation(client, 'sess', 'A4')).rejects.toThrow('still stale');
    expect(reads).toBe(2);
  });

  it('reads the thread from the tail, oldest first', async () => {
    const client = daemonOf(rows);
    const entries = await readItemConversation(client, 'sess', 'A4');
    expect(entries.map(entry => [entry.kind, entry.text])).toEqual(expected);
    expect(entries[1]?.at).toBe(Date.parse('2026-08-01T10:05:00.000Z'));
  });

  it('starts from the tail and stops at the first page that reaches back before the item', async () => {
    const old = filler(1_000, 8_000, () => '2026-01-01T00:00:00.000Z');
    const recent = [
      ...filler(20_000, 100, () => '2026-08-01T09:00:00.000Z'),
      row(30_001, 'user', 'about ^A4', '2026-08-01T10:00:00.000Z'),
      row(30_002, 'assistant', 'on it', '2026-08-01T10:01:00.000Z'),
      ...filler(40_000, 248, () => '2026-08-01T11:00:00.000Z'),
    ];
    const client = daemonOf([...old, ...recent]);
    const since = Date.parse('2026-07-31T00:00:00.000Z');
    const entries = await readItemConversation(client, 'sess', 'A4', since);
    expect(entries.map(entry => entry.text)).toEqual(['about ^A4', 'on it']);
    // 350 recent rows: the newest page of 200 holds only recent ones, the second holds the thread and reaches
    // back past the item, so the 8 000 older rows are never read.
    expect(client.tails).toEqual([
      { through: undefined, limit: 200 },
      { through: String(8_000 + 350 - 200), limit: 200 },
    ]);
  });

  it('joins a thread that straddles two tail pages', async () => {
    const lead = filler(1, 195, () => '2026-08-01T09:00:00.000Z');
    const thread = [
      row(500, 'user', 'about ^A4', '2026-08-01T10:00:00.000Z'),
      ...Array.from({ length: 8 }, (_, n) => row(501 + n, 'assistant', `answer ${n}`, '2026-08-01T10:01:00.000Z')),
    ];
    const client = daemonOf([...lead, ...thread]);
    const entries = await readItemConversation(client, 'sess', 'A4', Date.parse('2026-08-01T00:00:00.000Z'));
    expect(entries.map(entry => entry.text)).toEqual([
      'about ^A4',
      ...Array.from({ length: 8 }, (_, n) => `answer ${n}`),
    ]);
  });

  it('walks to the start of the conversation when the item gives no instant to stop at', async () => {
    const client = daemonOf([...filler(100, 450, () => '2026-07-01T00:00:00.000Z'), ...rows]);
    const entries = await readItemConversation(client, 'sess', 'A4');
    expect(entries).toHaveLength(3);
    expect(client.tails).toHaveLength(3);
  });
});

/** A ledger record as Conversation's `GET …/sends` answers it. */
const sendRecord = (message: string, fate: string, extra: object = {}) => ({
  v: 1,
  sendId: `s-${message}`,
  acceptedAt: '2026-08-01T10:05:00.000Z',
  acceptedTurn: 1,
  path: 'direct',
  message,
  attachmentIds: [],
  fate,
  ...extra,
});

describe('the receipts of the owner’s rows', () => {
  const thread = [
    row(1, 'user', 'reply ^A4: ship it', '2026-08-01T10:05:00.000Z'),
    row(2, 'assistant', 'Shipped.', '2026-08-01T10:06:00.000Z'),
    row(3, 'user', 'also ^A4 please', '2026-08-01T10:07:00.000Z'),
  ];
  const withLedger = (sends: ItemConversationClient['sends']): ItemConversationClient => ({
    ...daemonOf(thread),
    ...(sends === undefined ? {} : { sends }),
  });

  it('gives an owner row the record of the delivered send whose words it is, and never a cancelled one; the ferret’s rows none', async () => {
    const client = withLedger(async () => [
      { sendId: 'a', fate: 'cancelled', message: 'also ^A4 please', acceptedAt: '2026-08-01T10:07:00.000Z' },
      { sendId: 'b', fate: 'delivered', message: ' reply ^A4: ship it ', acceptedAt: '2026-08-01T10:05:00.000Z' },
      { sendId: 'c', fate: 'delivered', message: 'about something else' },
    ]);
    const entries = await readItemConversation(client, 'sess', 'A4');
    expect(entries.map(entry => [entry.kind, entry.send?.sendId])).toEqual([
      ['user', 'b'],
      ['assistant', undefined],
      ['user', undefined],
    ]);
  });

  const sent = (sendId: string, fate: string, acceptedAt: string, message = '^A4 ship it') => ({
    sendId,
    fate,
    message,
    acceptedAt,
  });
  const receiptsOf = async (rows: readonly Row[], sends: readonly ReturnType<typeof sent>[]) =>
    (await readItemConversation({ ...daemonOf(rows), sends: async () => sends }, 'sess', 'A4')).map(
      entry => entry.send?.sendId,
    );

  it('never puts a newer cancelled send on the older row that was delivered: the old row is Delivered', async () => {
    const rows = [row(1, 'user', '^A4 ship it', '2026-08-01T10:00:00.000Z')];
    for (const later of ['cancelled', 'held', 'queued']) {
      const sends = [
        sent('old', 'delivered', '2026-08-01T10:00:00.000Z'),
        sent('new', later, '2026-08-01T11:00:00.000Z'),
      ];
      expect(await receiptsOf(rows, sends)).toEqual(['old']);
    }
  });

  it('lets a cancelled send of the same words stand aside: it never reached a row, the one delivered send is the row’s', async () => {
    const rows = [row(1, 'user', '^A4 ship it', '2026-08-01T10:00:00.000Z')];
    const sends = [
      sent('early', 'cancelled', '2026-08-01T09:00:00.000Z'),
      sent('old', 'delivered', '2026-08-01T10:00:00.000Z'),
    ];
    expect(await receiptsOf(rows, sends)).toEqual(['old']);
  });

  it('gives no receipt when two delivered sends could both be the row’s, rather than guessing', async () => {
    const rows = [row(1, 'user', '^A4 ship it', '2026-08-01T10:00:00.000Z')];
    const sends = [
      sent('first', 'delivered', '2026-08-01T09:00:00.000Z'),
      sent('second', 'delivered', '2026-08-01T10:00:00.000Z'),
    ];
    expect(await receiptsOf(rows, sends)).toEqual([undefined]);
  });

  it('puts only a delivered send on a row: every other fate stays its own ledger entry', async () => {
    const rows = [row(1, 'user', '^A4 ship it', '2026-08-01T10:00:00.000Z')];
    const at = '2026-08-01T09:59:59.000Z';
    for (const [fate, extra] of [
      ['cancelled', {}],
      ['queued', {}],
      ['accepted', {}],
      ['unaccounted', {}],
      ['timed_out', {}],
      ['accepted', { held: true }],
      ['accepted', { typedNotSent: true }],
    ] as const) {
      expect(await receiptsOf(rows, [{ ...sent('s', fate, at), ...extra }])).toEqual([undefined]);
    }
  });

  it('gives two rows with the same words a receipt only where one send alone fits, and never one send twice', async () => {
    const twice = [
      row(1, 'user', '^A4 ship it', '2026-08-01T10:00:00.000Z'),
      row(2, 'user', '^A4 ship it', '2026-08-01T10:30:00.000Z'),
    ];
    expect(await receiptsOf(twice, [sent('only', 'delivered', '2026-08-01T10:00:00.000Z')])).toEqual([
      undefined,
      undefined,
    ]);
    const both = [
      sent('a', 'delivered', '2026-08-01T10:00:00.000Z'),
      sent('b', 'delivered', '2026-08-01T10:30:00.000Z'),
    ];
    expect(await receiptsOf(twice, both)).toEqual([undefined, undefined]);
  });

  it('takes a send the ledger accepted a few seconds after the row’s stamp, but not minutes after', async () => {
    const rows = [row(1, 'user', '^A4 ship it', '2026-08-01T10:00:00.000Z')];
    expect(await receiptsOf(rows, [sent('skew', 'delivered', '2026-08-01T10:00:04.000Z')])).toEqual(['skew']);
    expect(await receiptsOf(rows, [sent('late', 'delivered', '2026-08-01T10:00:06.000Z')])).toEqual([undefined]);
  });

  it('gives no receipt to a row or a record without an instant, which cannot be ordered', async () => {
    const stamped = [row(1, 'user', '^A4 ship it', '2026-08-01T10:00:00.000Z')];
    const bare = [row(1, 'user', '^A4 ship it')];
    expect(await receiptsOf(stamped, [{ sendId: 'x', fate: 'queued', message: '^A4 ship it' } as never])).toEqual([
      undefined,
    ]);
    expect(await receiptsOf(bare, [sent('x', 'delivered', '2026-08-01T10:00:00.000Z')])).toEqual([undefined]);
  });

  it('gives an edited or redacted row no receipt: its words are no longer the send’s', async () => {
    const rows = [row(1, 'user', '^A4 ship [redacted]', '2026-08-01T10:00:00.000Z')];
    expect(await receiptsOf(rows, [sent('old', 'delivered', '2026-08-01T10:00:00.000Z', '^A4 ship secret')])).toEqual([
      undefined,
    ]);
  });

  it('matches a long row by all its words, and not a long row that was cut short', async () => {
    const long = `^A4 ${'word '.repeat(2_000)}`;
    const rows = [row(1, 'user', long, '2026-08-01T10:00:00.000Z')];
    expect(await receiptsOf(rows, [sent('whole', 'delivered', '2026-08-01T10:00:00.000Z', long)])).toEqual(['whole']);
    expect(await receiptsOf(rows, [sent('whole', 'delivered', '2026-08-01T10:00:00.000Z', `${long}and more`)])).toEqual(
      [undefined],
    );
  });

  it('keeps the History when the ledger cannot be read, and when the host has no ledger', async () => {
    const failing = withLedger(async () => {
      throw new Error('offline');
    });
    for (const client of [failing, withLedger(undefined)]) {
      const entries = await readItemConversation(client, 'sess', 'A4');
      expect(entries.map(entry => entry.text)).toEqual(['reply ^A4: ship it', 'Shipped.', 'also ^A4 please']);
      expect(entries.every(entry => entry.send === undefined)).toBe(true);
    }
  });
});

describe('conversationClientOf', () => {
  const page = (messages: object[], previousCursor: string | null = null) => ({
    v: 1,
    ferret: 'sess',
    messages,
    nextCursor: null,
    previousCursor,
  });
  const message = (point: string, text: string) => ({
    point,
    role: 'user',
    text,
    selectionBinding: `b-${point}`,
  });
  const scripted = (answer: (route: string, init: { query?: Record<string, string> }) => unknown) => {
    const calls: { route: string; params?: Record<string, string>; query?: Record<string, string> }[] = [];
    return {
      calls,
      call: async (route: string, init: { params?: Record<string, string>; query?: Record<string, string> } = {}) => {
        calls.push({ route, ...init });
        return answer(route, init);
      },
    };
  };

  it('reads the newest page with `tail`, an older one `through` its cursor, by Conversation’s route key', async () => {
    const daemon = scripted(() => page([message('p1', 'hello')], 'c0'));
    const client = conversationClientOf(daemon as never);
    const newest = await client.messagesTail('sess', { limit: 200 });
    await client.messagesTail('sess', { limit: 200, through: 'c0' });
    expect(newest.messages.map(entry => entry.point)).toEqual(['p1']);
    expect(newest.previousCursor).toBe('c0');
    expect(daemon.calls).toEqual([
      {
        route: 'GET /v1/ferrets/:ferretId/messages',
        params: { ferretId: 'sess' },
        query: { limit: '200', tail: '1' },
      },
      {
        route: 'GET /v1/ferrets/:ferretId/messages',
        params: { ferretId: 'sess' },
        query: { limit: '200', through: 'c0' },
      },
    ]);
  });

  it('refuses a page that is not Conversation’s, rather than trusting its rows', async () => {
    const client = conversationClientOf(scripted(() => ({ messages: 'nope' })) as never);
    await expect(client.messagesTail('sess', { limit: 200 })).rejects.toThrow();
  });

  it('reads the send ledger and keeps only what a receipt claims: the flags a record carries when true', async () => {
    const daemon = scripted(() => ({
      sends: [
        sendRecord('a', 'queued', { held: true, withdrawn: true, typedNotSent: true }),
        sendRecord('b', 'delivered', { held: false, withdrawn: false, typedNotSent: false }),
      ],
    }));
    const sends = await conversationClientOf(daemon as never).sends?.('sess');
    expect(daemon.calls).toEqual([{ route: 'GET /v1/ferrets/:ferretId/sends', params: { ferretId: 'sess' } }]);
    expect(sends).toEqual([
      {
        sendId: 's-a',
        fate: 'queued',
        acceptedAt: '2026-08-01T10:05:00.000Z',
        message: 'a',
        attachmentIds: [],
        held: true,
        withdrawn: true,
        typedNotSent: true,
      },
      {
        sendId: 's-b',
        fate: 'delivered',
        acceptedAt: '2026-08-01T10:05:00.000Z',
        message: 'b',
        attachmentIds: [],
      },
    ]);
  });

  it('carries a refusal of the daemon as this half’s error, which the stale-cursor retry reads', async () => {
    const daemon = scripted(() => {
      throw Object.assign(new Error('old cursor'), { status: 409, code: 'message_cursor_stale' });
    });
    const client = conversationClientOf(daemon as never);
    await expect(client.messagesTail('sess', { limit: 1 })).rejects.toMatchObject({
      status: 409,
      code: 'message_cursor_stale',
    });
  });
});

describe('itemSince', () => {
  const HOUR = 60 * 60 * 1_000;
  const item = (extra: object) => ({ waitingSince: '2026-08-10T00:00:00.000Z', ...extra }) as never;

  it('is an hour before the earliest instant the item carries', () => {
    expect(itemSince(item({}))).toBe(Date.parse('2026-08-10T00:00:00.000Z') - HOUR);
    expect(
      itemSince(
        item({
          askedAt: '2026-08-09T00:00:00.000Z',
          history: [{ at: '2026-08-08T00:00:00.000Z', kind: 'updated' }],
          revisions: [{ at: '2026-08-12T00:00:00.000Z' }],
        }),
      ),
    ).toBe(Date.parse('2026-08-08T00:00:00.000Z') - HOUR);
  });

  it('is undefined when no instant of the item can be read', () => {
    expect(itemSince({ waitingSince: 'not a time' } as never)).toBeUndefined();
  });
});
