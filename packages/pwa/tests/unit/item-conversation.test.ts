import { describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import { type ItemConversationClient, itemSince, readItemConversation } from '../../src/lib/item-conversation.ts';

const row = (offset: number, role: string, text: string, timestamp?: string) => ({
  point: { v: 1, byteOffset: offset, blockIndex: 0 },
  role,
  text,
  selectionBinding: 'x',
  ...(timestamp === undefined ? {} : { timestamp }),
});
type Row = ReturnType<typeof row>;

interface Fake extends ItemConversationClient {
  readonly cursors: unknown[];
  readonly tails: { through?: string | undefined; limit?: number | undefined }[];
}

/** A daemon with `rows` as its whole conversation, paging forward by `messages` and backward by `messagesTail`. */
const daemonOf = (rows: readonly Row[], options: { tail: boolean }): Fake => {
  const cursors: unknown[] = [];
  const tails: Fake['tails'] = [];
  return {
    cursors,
    tails,
    health: async () => ({ features: options.tail ? [DAEMON_FEATURES.messagesTail] : [] }),
    messages: async (_session: string, cursor?: string, limit = 200) => {
      cursors.push(cursor);
      const from = cursor === undefined ? 0 : Number(cursor);
      const served = rows.slice(from, from + limit);
      return { messages: served, nextCursor: from + limit < rows.length ? String(from + limit) : null } as never;
    },
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
    row(2, 'assistant', 'Asking about !A4', '2026-08-01T10:00:00.000Z'),
    row(3, 'user', 'reply !A4: ship it', '2026-08-01T10:05:00.000Z'),
    row(4, 'developer', '!A4 hidden'),
    row(5, 'assistant', 'Shipped.'),
    row(6, 'user', 'about !A40'),
    row(7, 'assistant', 'not about it'),
  ];
  const expected = [
    ['assistant', 'Asking about !A4'],
    ['user', 'reply !A4: ship it'],
    ['assistant', 'Shipped.'],
  ];

  it('keeps the rows that name the item, and the ferret’s answer to the owner’s, across pages, oldest first', async () => {
    const client = daemonOf(rows, { tail: false });
    const entries = await readItemConversation(client, 'sess', 'A4');
    expect(entries.map(entry => [entry.kind, entry.text])).toEqual(expected);
    expect(entries[1]?.at).toBe(Date.parse('2026-08-01T10:05:00.000Z'));
    expect(client.tails).toEqual([]);
  });

  it('walks a machine without backward reads forward from the start, a page of 1000 at a time', async () => {
    const long = filler(100, 2_500, n => `2026-07-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`);
    const client = daemonOf([...long, ...rows], { tail: false });
    await readItemConversation(client, 'sess', 'A4');
    expect(client.cursors).toEqual([undefined, '1000', '2000']);
  });

  it('falls back to the forward walk when the machine’s health cannot be read', async () => {
    const client = { ...daemonOf(rows, { tail: true }), health: async () => Promise.reject(new Error('offline')) };
    const entries = await readItemConversation(client, 'sess', 'A4');
    expect(entries.map(entry => [entry.kind, entry.text])).toEqual(expected);
  });

  it('reads the same thread from the tail as it does from the start', async () => {
    const client = daemonOf(rows, { tail: true });
    const entries = await readItemConversation(client, 'sess', 'A4');
    expect(entries.map(entry => [entry.kind, entry.text])).toEqual(expected);
    expect(entries[1]?.at).toBe(Date.parse('2026-08-01T10:05:00.000Z'));
    expect(client.cursors).toEqual([]);
  });

  it('starts from the tail and stops at the first page that reaches back before the item', async () => {
    const old = filler(1_000, 8_000, () => '2026-01-01T00:00:00.000Z');
    const recent = [
      ...filler(20_000, 100, () => '2026-08-01T09:00:00.000Z'),
      row(30_001, 'user', 'about !A4', '2026-08-01T10:00:00.000Z'),
      row(30_002, 'assistant', 'on it', '2026-08-01T10:01:00.000Z'),
      ...filler(40_000, 248, () => '2026-08-01T11:00:00.000Z'),
    ];
    const client = daemonOf([...old, ...recent], { tail: true });
    const since = Date.parse('2026-07-31T00:00:00.000Z');
    const entries = await readItemConversation(client, 'sess', 'A4', since);
    expect(entries.map(entry => entry.text)).toEqual(['about !A4', 'on it']);
    // 350 recent rows: the newest page of 200 holds only recent ones, the second holds the thread and reaches
    // back past the item, so the 8 000 older rows are never read.
    expect(client.tails).toEqual([
      { through: undefined, limit: 200 },
      { through: String(8_000 + 350 - 200), limit: 200 },
    ]);
    expect(client.cursors).toEqual([]);
  });

  it('joins a thread that straddles two tail pages', async () => {
    const lead = filler(1, 195, () => '2026-08-01T09:00:00.000Z');
    const thread = [
      row(500, 'user', 'about !A4', '2026-08-01T10:00:00.000Z'),
      ...Array.from({ length: 8 }, (_, n) => row(501 + n, 'assistant', `answer ${n}`, '2026-08-01T10:01:00.000Z')),
    ];
    const client = daemonOf([...lead, ...thread], { tail: true });
    const entries = await readItemConversation(client, 'sess', 'A4', Date.parse('2026-08-01T00:00:00.000Z'));
    expect(entries.map(entry => entry.text)).toEqual([
      'about !A4',
      ...Array.from({ length: 8 }, (_, n) => `answer ${n}`),
    ]);
  });

  it('walks to the start of the conversation when the item gives no instant to stop at', async () => {
    const client = daemonOf([...filler(100, 450, () => '2026-07-01T00:00:00.000Z'), ...rows], { tail: true });
    const entries = await readItemConversation(client, 'sess', 'A4');
    expect(entries).toHaveLength(3);
    expect(client.tails).toHaveLength(3);
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
