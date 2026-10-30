import { describe, expect, it } from 'bun:test';
import { type ItemConversationClient, readItemConversation } from '../../src/lib/item-conversation.ts';

const row = (offset: number, role: string, text: string, timestamp?: string) => ({
  point: { v: 1, byteOffset: offset, blockIndex: 0 },
  role,
  text,
  selectionBinding: 'x',
  ...(timestamp === undefined ? {} : { timestamp }),
});

const clientOf = (
  pages: readonly (readonly ReturnType<typeof row>[])[],
): ItemConversationClient & { cursors: unknown[] } => {
  const cursors: unknown[] = [];
  return {
    cursors,
    messages: async (_session: string, cursor?: string) => {
      cursors.push(cursor);
      const at = cursor === undefined ? 0 : Number(cursor);
      return { messages: pages[at] ?? [], nextCursor: at + 1 < pages.length ? String(at + 1) : null } as never;
    },
  } as never;
};

describe('readItemConversation', () => {
  it('keeps the user and ferret rows that name the item, across pages, oldest first, with their times', async () => {
    const client = clientOf([
      [row(1, 'user', 'unrelated'), row(2, 'assistant', 'Asking about !A4', '2026-08-01T10:00:00.000Z')],
      [
        row(3, 'user', 'reply !A4: ship it', '2026-08-01T10:05:00.000Z'),
        row(4, 'developer', '!A4 hidden'),
        row(5, 'user', 'about !A40'),
      ],
    ]);
    const entries = await readItemConversation(client, 'sess', 'A4');
    expect(entries.map(entry => [entry.kind, entry.text])).toEqual([
      ['assistant', 'Asking about !A4'],
      ['user', 'reply !A4: ship it'],
      ['user', 'about !A40'],
    ]);
    expect(entries[1]?.at).toBe(Date.parse('2026-08-01T10:05:00.000Z'));
    expect(client.cursors).toEqual([undefined, '1']);
  });
});
