import { expect, it } from 'bun:test';
import type { AskSourceSpec } from '../../../contract/index.ts';
import { asksPort } from '../../../daemon/adapters/asks-port.ts';
import type { AgendaService } from '../../../daemon/lib/agenda/index.ts';
import { cardAskReference } from '../../../daemon/lib/protocol/agenda-card-asks.ts';
import { agendaService } from './routes/support.ts';

/**
 * A card ask a v4 ledger carries (`item.cardAsks`, an item such as `!A1 [task]` on `&I1`): the Board's `card` source
 * must see it as the card's ask, or a restart raises a SECOND one for the same gate (the duplicate the owner saw after
 * conversion). The carrier keeps its own source (`ferret`); only a read FOR the `card` source lists the carried asks.
 */

const GATE = {
  cardId: 'I1',
  laneId: 'to-test',
  laneName: 'To test',
  entry: 3,
  projectId: 'p1',
  options: [
    { id: 'done', label: 'Done', outcome: 'next' as const },
    { id: 'reopen', label: 'Not good', outcome: 'reopen-with-agenda' as const },
  ],
};
const REFERENCE = cardAskReference({ gate: GATE });
const boards = { ferrets: async () => ['s1'] };
const CARD_SOURCE: AskSourceSpec = { schema: undefined as never, title: 'Card', form: false };

/** One ferret's own `A1` carrying one card ask, on the real engine. */
async function carried() {
  const agenda = agendaService();
  await agenda.raise(
    's1',
    {
      source: 'agent-raised',
      sourceRef: null,
      title: 'Rich CI cache',
      subject: 'Rich CI cache',
      context: 'The cache waits.',
      premise: 'Try it.',
      why: 'Ready',
      howToResolve: 'Say so.',
      ask: { kind: 'open-question' },
    },
    { kind: 'agent', sessionId: 's1', name: null },
  );
  await agenda.cardAsk('s1', 'A1', { kind: 'attach', ask: { gate: GATE } });
  const api = asksPort(agenda, boards, key => (key === 'card' ? CARD_SOURCE : 'unavailable'));
  return { agenda, api };
}

const itemsOf = async (agenda: AgendaService) => {
  const listed = await agenda.list('s1');
  if (!listed.ok) throw new Error(listed.error.message);
  return listed.value;
};

it('lists a carried open card ask as an open ask of the card source, by its gate entry', async () => {
  const { api } = await carried();
  const open = await api.open({ source: 'card' as never, state: 'open' });
  expect(open.map(ask => [ask.id, ask.ferret, ask.entry, ask.state])).toEqual([['A1', 's1', REFERENCE, 'open']]);
});

it('finds it by entry, and by no other entry', async () => {
  const { api } = await carried();
  expect(await api.open({ source: 'card' as never, entry: REFERENCE as never })).toHaveLength(1);
  expect(await api.open({ source: 'card' as never, entry: 'gate:I1:to-test:4' as never })).toHaveLength(0);
});

it('leaves the carrier an ordinary ask of its own source, listed once', async () => {
  const { api } = await carried();
  const all = await api.open({});
  expect(all.map(ask => `${ask.id}:${ask.source}`)).toEqual(['A1:ferret']);
});

it('does not list a carried card ask the owner already answered as open', async () => {
  const { agenda, api } = await carried();
  await agenda.cardAsk('s1', 'A1', {
    kind: 'answered',
    reference: REFERENCE,
    answer: {
      at: '2026-11-07T10:00:00.000Z',
      response: { kind: 'multiple-choice', choice: 'Done' },
      receipt: 'a'.repeat(64),
    },
  });
  expect(await api.open({ source: 'card' as never, state: 'open' })).toHaveLength(0);
});

it('withdrawing a carried card ask takes the ask off its carrier and leaves the carrier open', async () => {
  const { agenda, api } = await carried();
  await api.close({ ferret: 's1' as never, id: 'A1' as never }, 'withdrawn');
  const board = await itemsOf(agenda);
  expect(board.items.map(item => item.id)).toEqual(['A1']);
  expect(board.items[0]?.cardAsks).toBeUndefined();
  expect(await api.open({ source: 'card' as never, state: 'open' })).toHaveLength(0);
});

it('withdrawing one carried gate entry keeps the carrier and every other carried ask on it', async () => {
  const { agenda, api } = await carried();
  const second = { ...GATE, cardId: 'I2' };
  await agenda.cardAsk('s1', 'A1', { kind: 'attach', ask: { gate: second } });
  const ref = { ferret: 's1' as never, id: 'A1' as never };
  await api.close(ref, 'withdrawn', REFERENCE as never);
  const board = await itemsOf(agenda);
  expect(board.items.map(item => item.id)).toEqual(['A1']);
  expect((await api.open({ source: 'card' as never, state: 'open' })).map(ask => ask.entry)).toEqual([
    cardAskReference({ gate: second }) as never,
  ]);
  // Without an entry the carrier's whole set goes, as before.
  await api.close(ref, 'withdrawn');
  expect(await api.open({ source: 'card' as never, state: 'open' })).toHaveLength(0);
});
