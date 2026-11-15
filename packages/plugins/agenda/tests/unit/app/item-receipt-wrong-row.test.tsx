import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readItemConversation } from '../../../app/lib/item-conversation.ts';
import { OwnWordsRow } from '../../../app/features/agenda/history-rows.tsx';

test('an old delivered row must not inherit a newer cancelled send with identical words', async () => {
  const entries = await readItemConversation(
    {
      messagesTail: async () => ({
        messages: [
          { point: 'old-transcript-row', role: 'user', text: '!A4 ship it', timestamp: '2026-08-01T10:00:00.000Z' },
        ],
        previousCursor: null,
      }),
      sends: async () => [
        { sendId: 'old-delivered', message: '!A4 ship it', acceptedAt: '2026-08-01T10:00:00.000Z', fate: 'delivered' },
        { sendId: 'new-cancelled', message: '!A4 ship it', acceptedAt: '2026-08-01T11:00:00.000Z', fate: 'cancelled' },
      ],
    },
    'sess',
    'A4',
  );
  const entry = entries[0]!;
  const html = renderToStaticMarkup(
    <OwnWordsRow at={entry.at!} reached={{ via: 'transcript', answered: false, send: entry.send }}>
      {entry.text}
    </OwnWordsRow>,
  );
  expect(html).not.toContain('data-send-receipt="cancelled"');
  expect(entry.send?.sendId).toBe('old-delivered');
});
