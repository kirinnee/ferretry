import { describe, it } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import should from 'should';
import { AGENDA_READ_CONCURRENCY, AgendaCardLinks, type AgendaItemsReader } from '../../../src/lib/board/index.ts';
import { card, MACHINE, NOW } from './support.ts';

/** An open agenda item raised by a ferret, with whatever fields a case needs. */
const item = (id: string, extra: Partial<AgendaItem> = {}): AgendaItem =>
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
  }) as AgendaItem;

const gate = (cardId: string) => ({
  cardId,
  laneId: 'tested',
  laneName: 'Ready to try',
  entry: 1,
  projectId: 'p1',
  options: [{ id: 'o0', label: 'Done', outcome: 'close' as const }],
});
const ANSWER = { at: NOW, response: { kind: 'multiple-choice' as const, choice: 'Done' }, receipt: 'a'.repeat(64) };

class FakeAgendas implements AgendaItemsReader {
  readonly reads: string[] = [];

  constructor(
    private readonly agendas: Readonly<Record<string, readonly AgendaItem[]>>,
    private readonly failing: ReadonlySet<string> = new Set(),
  ) {}

  async open(sessionId: string): Promise<readonly AgendaItem[]> {
    this.reads.push(sessionId);
    if (this.failing.has(sessionId)) throw new Error('agenda.json is damaged');
    return this.agendas[sessionId] ?? [];
  }
}

const links = (agendas: FakeAgendas, warnings: string[] = []) =>
  new AgendaCardLinks(agendas, () => MACHINE, { warn: message => warnings.push(message) });

describe("the agenda's link to cards", () => {
  it('should count every open agenda carrying a card, and the ones with its unanswered card ask as asking', async () => {
    // Arrange
    const agendas = new FakeAgendas({
      child: [
        item('A1', { task: { id: 'F2' }, cardAsks: [{ gate: gate('F2'), at: NOW }] }),
        item('A2', { task: { id: 'F2' } }),
        item('A3', { task: { id: 'F1', machineId: MACHINE } }),
        item('A4', { task: { id: 'F9' }, cardAsks: [{ gate: gate('F1'), at: NOW, answer: ANSWER }] }),
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
      asking: [{ sessionId: 'child', id: 'A1' }],
    });
    should(asks.get('F1')).deepEqual({
      open: [
        { sessionId: 'child', id: 'A3' },
        { sessionId: 'child', id: 'A4' },
      ],
      asking: [],
    });
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

  it('should say an unchanged damaged agenda once, and again when it fails differently', async () => {
    // Arrange — the reader hands back the same error object while the file is unchanged.
    const warnings: string[] = [];
    const same = new Error('invalid agenda ledger: lead/agenda.json');
    let failure = same;
    const reader = new AgendaCardLinks(
      {
        open: async () => {
          throw failure;
        },
      },
      () => MACHINE,
      { warn: message => warnings.push(message) },
    );

    // Act
    for (let each = 0; each < 4; each += 1) await reader.asksFor([card({ assignee: 'lead' })]);
    failure = new Error('invalid agenda ledger: lead/agenda.json (rewritten, still damaged)');
    await reader.asksFor([card({ assignee: 'lead' })]);

    // Assert
    should(warnings).deepEqual([
      'could not read the agenda of lead for its cards: invalid agenda ledger: lead/agenda.json',
      'could not read the agenda of lead for its cards: invalid agenda ledger: lead/agenda.json (rewritten, still damaged)',
    ]);
  });

  it('should say a first failure even when the rejection is undefined, and once more when the agenda recovers and fails again', async () => {
    // Arrange
    const warnings: string[] = [];
    let outcome: 'fail' | 'ok' = 'fail';
    const reader = new AgendaCardLinks(
      {
        open: async () => {
          if (outcome === 'fail') throw undefined;
          return [];
        },
      },
      () => MACHINE,
      { warn: message => warnings.push(message) },
    );

    // Act
    await reader.asksFor([card({ assignee: 'lead' })]);
    await reader.asksFor([card({ assignee: 'lead' })]);
    outcome = 'ok';
    await reader.asksFor([card({ assignee: 'lead' })]);
    outcome = 'fail';
    await reader.asksFor([card({ assignee: 'lead' })]);

    // Assert
    should(warnings).have.length(2);
  });

  it('should keep at most a bounded number of said failures, forgetting the oldest first', async () => {
    // Arrange
    const warnings: string[] = [];
    const damaged = new Error('damaged');
    const reader = new AgendaCardLinks(
      {
        open: async () => {
          throw damaged;
        },
      },
      () => MACHINE,
      { warn: message => warnings.push(message) },
    );
    const owners = Array.from({ length: 600 }, (_, index) => `ferret-${index}`);
    const cards = owners.map(owner => card({ assignee: owner }));

    // Act — a second equal read says again what the bound had forgotten (past it the oldest go first).
    await reader.asksFor(cards);
    const first = warnings.length;
    await reader.asksFor(cards);

    // Assert
    should(first).be.aboveOrEqual(600);
    should(warnings.length).be.above(first);
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

  it('should look up the agenda homes in bounded batches too, never all at once', async () => {
    // Arrange
    const owners = Array.from({ length: AGENDA_READ_CONCURRENCY * 3 + 1 }, (_, index) => `ferret-${index}`);
    let inFlight = 0;
    let widest = 0;
    const looked: string[] = [];
    const homes = {
      of: async (sessionId: string) => {
        looked.push(sessionId);
        inFlight += 1;
        widest = Math.max(widest, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return sessionId;
      },
    };

    // Act
    await new AgendaCardLinks(new FakeAgendas({}), () => MACHINE, { warn: () => undefined }, homes).asksFor(
      owners.map((owner, index) => card({ id: `F${index + 1}`, owner })),
    );

    // Assert
    should(looked).deepEqual(owners);
    should(widest).equal(AGENDA_READ_CONCURRENCY);
  });
});
