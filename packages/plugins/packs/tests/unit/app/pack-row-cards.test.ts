import { describe, expect, test } from 'bun:test';
import type { ConversationRowEntry } from '@ferretry/plugin-conversation/contract';
import { packCardsOf } from '../../../app/lib/pack-row-cards.ts';

const row = (
  tools: ConversationRowEntry['tools'],
  overrides: Partial<ConversationRowEntry> = {},
): ConversationRowEntry => ({
  id: 'tools:k1',
  kind: 'tool',
  text: 'ran a tool',
  at: Date.UTC(2026, 9, 20, 2, 0, 0),
  ...(tools === undefined ? {} : { tools }),
  ...overrides,
});

const STARTED = 'Started nadia (mvnadia-1) on claude-auto-work — decided by you.';

describe('the Pack cards of one slot row', () => {
  test('a row with a Pack start is a "new" card carrying its command and answer', () => {
    const cards = packCardsOf(
      row([
        {
          key: 'k1',
          name: 'Bash',
          command: 'fy new --runtime claude-auto-work "go"',
          result: { text: STARTED },
        },
      ]),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.pack?.kind).toBe('new');
    expect(cards[0]?.tools?.[0]?.use.input).toEqual({ command: 'fy new --runtime claude-auto-work "go"' });
  });

  test('a wait in the same row folds into the start it collected', () => {
    const cards = packCardsOf(
      row([
        { key: 'k1', name: 'Bash', command: 'fy new "go"', result: { text: STARTED } },
        { key: 'k2', name: 'Bash', command: 'fy wait nadia', result: { text: 'x' } },
      ]),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.pack?.kind === 'new' && cards[0].pack.collected !== undefined).toBe(true);
  });

  test('a wait whose start is in another row is a card of its own', () => {
    const cards = packCardsOf(row([{ key: 'k2', name: 'shell', command: 'fy wait nadia' }]));
    expect(cards.map(card => card.pack?.kind)).toEqual(['wait']);
  });

  test('a row with no Pack command, no tools, or another kind draws no card', () => {
    expect(packCardsOf(row([{ key: 'k', name: 'Bash', command: 'ls -la' }]))).toEqual([]);
    expect(packCardsOf(row(undefined))).toEqual([]);
    expect(packCardsOf(row([{ key: 'k', name: 'Bash', command: 'fy new "x"' }], { kind: 'assistant' }))).toEqual([]);
  });
});
