import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readItemConversation } from '../../../app/lib/item-conversation.ts';
import { OwnWordsRow } from '../../../app/features/agenda/history-rows.tsx';

const words = '^A4 ship it';
const row = (point: string, timestamp: string) => ({ point, role: 'user', text: words, timestamp });
const send = (sendId: string, fate: string, acceptedAt: string) => ({ sendId, fate, acceptedAt, message: words });
const read = (messages: ReturnType<typeof row>[], sends: ReturnType<typeof send>[]) =>
  readItemConversation(
    {
      messagesTail: async () => ({ messages, previousCursor: null }),
      sends: async () => sends,
    },
    'sess',
    'A4',
  );
const receiptMarkup = (entry: Awaited<ReturnType<typeof read>>[number]) =>
  renderToStaticMarkup(
    <OwnWordsRow at={entry.at!} reached={{ via: 'transcript', answered: false, send: entry.send }}>
      {entry.text}
    </OwnWordsRow>,
  );

test('common case keeps the receipt for one delivered send and one row', async () => {
  const [entry] = await read(
    [row('one', '2026-08-01T10:00:00.000Z')],
    [send('one', 'delivered', '2026-08-01T10:00:00.000Z')],
  );
  expect(entry?.send?.sendId).toBe('one');
  expect(receiptMarkup(entry!)).toContain('data-send-receipt="delivered"');
});

test('six seconds of daemon/runtime skew cannot turn an actual delivered row into Cancelled', async () => {
  // Daemon clock is six seconds ahead of runtime. Cancelled attempt at runtime 09:59:53,
  // then delivered resend at runtime 10:00:00, matching the transcript row.
  const [entry] = await read(
    [row('delivered-resend', '2026-08-01T10:00:00.000Z')],
    [
      send('earlier-cancelled-attempt', 'cancelled', '2026-08-01T09:59:59.000Z'),
      send('actual-delivered-resend', 'delivered', '2026-08-01T10:00:06.000Z'),
    ],
  );
  expect(receiptMarkup(entry!)).not.toContain('data-send-receipt="cancelled"');
});

test('a cancelled attempt accepted just before a direct runtime row cannot describe that row', async () => {
  // The transcript can include owner messages typed directly into the runtime.
  const [entry] = await read(
    [row('direct-owner-input', '2026-08-01T10:00:00.000Z')],
    [send('cancelled-before-direct-input', 'cancelled', '2026-08-01T09:59:59.000Z')],
  );
  expect(receiptMarkup(entry!)).not.toContain('data-send-receipt="cancelled"');
});

test('an ambiguous second row also claims the first candidate; two rows and sends do not prove identity', async () => {
  const entries = await read(
    [row('direct-owner-input', '2026-08-01T10:00:00.000Z'), row('actual-delivered-send', '2026-08-01T10:30:00.000Z')],
    [
      send('earlier-cancelled-attempt', 'cancelled', '2026-08-01T09:59:59.000Z'),
      send('actual-delivered-send', 'delivered', '2026-08-01T10:30:00.000Z'),
    ],
  );
  expect(entries.map(entry => entry.send?.sendId)).toEqual([undefined, undefined]);
});
