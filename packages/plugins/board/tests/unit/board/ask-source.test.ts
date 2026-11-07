import { describe, expect, test } from 'bun:test';
import { as, boot, makeCard } from '../../integration/daemon/harness.ts';

/** Lead data-loss gap: a card keeps where its ask was said (today's `ask.source`), stored and served. */
describe('a card’s ask source', () => {
  test('is stored with the ask text and read back as it was said', async () => {
    const { host } = await boot();
    const made = await makeCard(host, { ask: { text: 'Make the badge green.', source: 'owner (ask !A3)' } });

    const stored = JSON.parse(host.state('board').files.get(`cards/${made.id}.json`) ?? '{}') as {
      ask?: { text: string; source: string };
    };
    expect(stored.ask).toEqual({ text: 'Make the badge green.', source: 'owner (ask !A3)' });
    const read = await host.request('GET', `/v1/board/cards/${made.id}`, { headers: as('owner') });
    expect(read.json<{ card: { ask: { source: string } } }>().card.ask.source).toBe('owner (ask !A3)');
  });
});
