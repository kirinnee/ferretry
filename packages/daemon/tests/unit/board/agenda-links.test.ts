import { describe, it } from 'bun:test';
import type { AttentionItem } from '@ferretry/protocol';
import should from 'should';
import { AGENDA_READ_CONCURRENCY, AgendaCardLinks, type AgendaItemsReader } from '../../../src/lib/board/index.ts';
import { card, MACHINE, NOW } from './support.ts';

/** An open agenda item raised by a ferret, with whatever fields a case needs. */
const item = (id: string, extra: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    id,
    raisedBy: 'agent',
    raisedBySession: 'child',
    raisedByName: null,
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Approve the design?',
    why: 'it blocks the build',
    context: null,
    howToResolve: 'answer it',
    waitingSince: NOW,
    ...extra,
  }) as AttentionItem;

class FakeAgendas implements AgendaItemsReader {
  readonly reads: string[] = [];

  constructor(
    private readonly agendas: Readonly<Record<string, readonly AttentionItem[]>>,
    private readonly failing: ReadonlySet<string> = new Set(),
  ) {}

  async open(sessionId: string): Promise<readonly AttentionItem[]> {
    this.reads.push(sessionId);
    if (this.failing.has(sessionId)) throw new Error('agenda.json is damaged');
    return this.agendas[sessionId] ?? [];
  }
}

const links = (agendas: FakeAgendas, warnings: string[] = []) =>
  new AgendaCardLinks(agendas, () => MACHINE, { warn: message => warnings.push(message) });

describe("the agenda's link to cards", () => {
  it('should count every open ask naming a card, and the blocking ones as waiting on the owner', async () => {
    // Arrange
    const agendas = new FakeAgendas({
      child: [
        item('A1', { task: { id: 'F2' }, blockingNow: true }),
        item('A2', { task: { id: 'F2' } }),
        item('A3', { task: { id: 'F1', machineId: MACHINE } }),
      ],
      lead: [item('A1', { task: { id: 'F2' } })],
    });
    const cards = [card({ id: 'F1' }), card({ id: 'F2', owner: 'lead', assignee: 'child' })];

    // Act
    const asks = await links(agendas).asksFor(cards);

    // Assert
    should(asks.get('F2')).deepEqual({
      open: [
        { sessionId: 'lead', id: 'A1' },
        { sessionId: 'child', id: 'A1' },
        { sessionId: 'child', id: 'A2' },
      ],
      blocking: [{ sessionId: 'child', id: 'A1' }],
    });
    should(asks.get('F1')).deepEqual({ open: [{ sessionId: 'child', id: 'A3' }], blocking: [] });
    should(agendas.reads).deepEqual(['lead', 'child']);
  });

  it('should leave out notices, items with no card, cards of another machine and cards not on the board', async () => {
    // Arrange
    const agendas = new FakeAgendas({
      lead: [
        item('A1', { task: { id: 'F1' }, notice: true }),
        item('A2'),
        item('A3', { task: null }),
        item('A4', { task: { id: 'F1', machineId: 'other-machine' } }),
        item('A5', { task: { id: 'F77' } }),
      ],
    });

    // Act
    const asks = await links(agendas).asksFor([card()]);

    // Assert
    should(asks.size).equal(0);
  });

  it('should cost an unreadable agenda its asks, never the board read, and say so', async () => {
    // Arrange
    const warnings: string[] = [];
    const agendas = new FakeAgendas({ child: [item('A1', { task: { id: 'F1' } })] }, new Set(['lead']));
    const failingWith = new AgendaCardLinks(
      {
        open: async sessionId => {
          if (sessionId === 'lead') throw 'disk gone';
          return await agendas.open(sessionId);
        },
      },
      () => MACHINE,
      { warn: message => warnings.push(message) },
    );

    // Act
    const asks = await links(agendas, warnings).asksFor([card({ assignee: 'child' })]);
    const again = await failingWith.asksFor([card({ assignee: 'child' })]);

    // Assert
    should(asks.get('F1')?.open).deepEqual([{ sessionId: 'child', id: 'A1' }]);
    should(again.get('F1')?.open).deepEqual([{ sessionId: 'child', id: 'A1' }]);
    should(warnings).deepEqual([
      'could not read the agenda of lead for its cards: agenda.json is damaged',
      'could not read the agenda of lead for its cards: disk gone',
    ]);
  });

  it('should read the agendas in bounded batches', async () => {
    // Arrange
    const owners = Array.from({ length: AGENDA_READ_CONCURRENCY + 3 }, (_, index) => `ferret-${index}`);
    const agendas = new FakeAgendas({});

    // Act
    await links(agendas).asksFor(owners.map((owner, index) => card({ id: `F${index + 1}`, owner })));

    // Assert
    should(agendas.reads).deepEqual(owners);
  });
});
