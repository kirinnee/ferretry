import { describe, it } from 'bun:test';
import { type AgendaItem, AgendaItemSchema, type AgendaSnapshot } from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaBoardChange,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  agendaSnapshot,
  type SessionStops,
} from '../../../src/lib/agenda/index.ts';
import { AgendaBuzz, type BuzzSink } from '../../../src/lib/notifications/buzz.ts';

const SESSION = 'session-1';
const NOW = '2026-10-23T10:00:00.000Z';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };

class Boards implements AgendaLedgerRepository {
  ledger: AgendaLedger | null = null;
  unreadable = false;

  async read(): Promise<AgendaLedger | null> {
    if (this.unreadable) throw new Error('board cannot be read');
    return this.ledger;
  }

  async transact(_sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledger);
    if (mutation.ok && mutation.changed) this.ledger = mutation.ledger;
    return mutation;
  }
}

class Sink implements BuzzSink {
  readonly stops: string[] = [];
  readonly deadlines: string[] = [];
  readonly notices: string[] = [];

  async stopped(_session: string, stoppedAt: string, snapshot: AgendaSnapshot): Promise<void> {
    this.stops.push(`${stoppedAt}:${snapshot.items.map(item => item.id).join(',')}`);
  }

  async deadline(_session: string, item: AgendaItem): Promise<void> {
    this.deadlines.push(item.id);
  }

  async raised(_session: string, item: AgendaItem): Promise<void> {
    this.notices.push(item.id);
  }
}

const ASK = {
  surface: true,
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Rebase onto main now?',
  why: 'main moved under the PR.',
  context: 'Finishing the relay PR.',
  premise: 'A ferret needs the owner.',
  howToResolve: 'Pick one.',
  ask: { kind: 'multiple-choice' as const, options: [{ label: 'Rebase now' }, { label: 'Wait' }] },
};

function world(options: { idleSince?: string; warnHours?: number } = {}) {
  const boards = new Boards();
  const sink = new Sink();
  const stops: SessionStops = { current: async () => options.idleSince };
  const buzz = new AgendaBuzz(boards, stops, sink, { now: () => NOW }, options.warnHours);
  const agenda = new AgendaService(
    boards,
    { now: () => NOW },
    { has: async () => true },
    { raised: async () => undefined },
    { changed: async () => undefined },
  );
  const snapshot = (): AgendaSnapshot => agendaSnapshot(boards.ledger as AgendaLedger);
  return { boards, sink, buzz, attention: agenda, snapshot };
}

/** Puts a deadline on an item already on the board: the state machine's raise carries the ask, the date is the ferret's edit. */
function dated(boards: Boards, id: string, neededBy: string): void {
  const ledger = boards.ledger as AgendaLedger;
  boards.ledger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.item.id === id ? ({ ...entry, item: { ...entry.item, neededBy } } as typeof entry) : entry,
    ),
  };
}

const change = (actor: AgendaBoardChange['actor']): AgendaBoardChange =>
  ({ change: 'edited', actor, via: 'api' }) as unknown as AgendaBoardChange;

const notice = (ping: boolean): AgendaItem =>
  AgendaItemSchema.parse({
    id: 'A9',
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Build is green',
    why: 'Build is green',
    waitingSince: NOW,
    howToResolve: 'Nothing to do.',
    ask: { kind: 'open-question' },
    raisedBy: 'agent',
    raisedBySession: SESSION,
    raisedByName: 'Ada',
    notice: true,
    ...(ping ? { ping: true } : {}),
  });

describe('AgendaBuzz stops', () => {
  it('should report a stop, named by the idle instant, when the ferret is idle with an item on the owner', async () => {
    // Arrange
    const { attention: agenda, buzz, sink } = world({ idleSince: '2026-10-23T09:55:00.000Z' });
    await agenda.raise(SESSION, ASK, AGENT);

    // Act
    await buzz.turnChanged(SESSION);

    // Assert
    should(sink.stops).deepEqual(['2026-10-23T09:55:00.000Z:A1']);
  });

  it('should report nothing while the ferret works, however many items it raises', async () => {
    // Arrange
    const { attention: agenda, buzz, sink, snapshot } = world();
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Second?' }, AGENT);

    // Act
    for (const item of snapshot().items) await buzz.raised(SESSION, item, snapshot());
    await buzz.turnChanged(SESSION);

    // Assert
    should(sink.stops).deepEqual([]);
    should(sink.deadlines).deepEqual([]);
  });

  it('should report the stop when a ferret raises, or a warden or source moves, an item while it is already idle', async () => {
    // Arrange
    const { attention: agenda, buzz, sink, snapshot } = world({ idleSince: NOW });
    await agenda.raise(SESSION, ASK, AGENT);

    // Act
    await buzz.raised(SESSION, snapshot().items[0] as AgendaItem, snapshot());
    await buzz.changed(SESSION, change({ kind: 'daemon', cause: 'warden' } as never));

    // Assert
    should(sink.stops.length).equal(2);
  });

  it('should never buzz for the owner’s own moves on the board', async () => {
    // Arrange
    const { attention: agenda, buzz, sink } = world({ idleSince: NOW });
    await agenda.raise(SESSION, ASK, AGENT);

    // Act
    await buzz.changed(SESSION, change({ kind: 'human' }));

    // Assert
    should(sink.stops).deepEqual([]);
  });

  it('should report no stop when nothing waits on the owner', async () => {
    // Arrange
    const { buzz, sink } = world({ idleSince: NOW });

    // Act
    await buzz.turnChanged(SESSION);

    // Assert
    should(sink.stops).deepEqual([]);
  });

  it('should stay silent, and not throw, when the board cannot be read', async () => {
    // Arrange
    const { boards, buzz, sink } = world({ idleSince: NOW });
    boards.unreadable = true;

    // Act + Assert
    await should(buzz.turnChanged(SESSION)).be.fulfilled();
    should(sink.stops).deepEqual([]);
  });
});

describe('AgendaBuzz deadlines', () => {
  const soon = '2026-10-23T12:00:00.000Z';
  const later = '2026-10-23T20:00:00.000Z';

  it('should report an item whose neededBy is within the warning window, and not one further off or undated', async () => {
    // Arrange
    const { attention: agenda, boards, buzz, sink } = world();
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Later?' }, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'No date?' }, AGENT);
    dated(boards, 'A1', soon);
    dated(boards, 'A2', later);

    // Act
    await buzz.sweep([SESSION]);

    // Assert
    should(sink.deadlines).deepEqual(['A1']);
  });

  it('should widen and narrow the window by its setting', async () => {
    // Arrange
    const wide = world({ warnHours: 12 });
    const narrow = world({ warnHours: 1 });
    for (const w of [wide, narrow]) {
      await w.attention.raise(SESSION, ASK, AGENT);
      dated(w.boards, 'A1', later);
    }

    // Act
    await wide.buzz.sweep([SESSION]);
    await narrow.buzz.sweep([SESSION]);

    // Assert
    should(wide.sink.deadlines).deepEqual(['A1']);
    should(narrow.sink.deadlines).deepEqual([]);
  });

  it('should look at deadlines only on a sweep: a ferret already idle at daemon start is not newly stopped', async () => {
    // Arrange
    const { attention: agenda, boards, buzz, sink } = world({ idleSince: NOW });
    await agenda.raise(SESSION, ASK, AGENT);
    dated(boards, 'A1', soon);

    // Act
    await buzz.sweep([SESSION]);

    // Assert
    should(sink.stops).deepEqual([]);
    should(sink.deadlines).deepEqual(['A1']);
  });

  it('should sweep every board even when one cannot be read', async () => {
    // Arrange
    const { attention: agenda, buzz, sink, boards } = world();
    await agenda.raise(SESSION, ASK, AGENT);
    dated(boards, 'A1', soon);
    const read = boards.read.bind(boards);
    let calls = 0;
    boards.read = async () => {
      calls += 1;
      if (calls === 1) throw new Error('first board unreadable');
      return await read();
    };

    // Act
    await buzz.sweep(['broken', SESSION]);

    // Assert
    should(sink.deadlines).deepEqual(['A1']);
  });
});

describe('AgendaBuzz notices', () => {
  it('should hand a notice to the sink and never treat it as a stop', async () => {
    // Arrange
    const { buzz, sink, attention: agenda, snapshot } = world({ idleSince: NOW });
    await agenda.raise(SESSION, ASK, AGENT);
    const item = notice(true);

    // Act
    await buzz.raised(SESSION, item, snapshot());

    // Assert
    should(sink.notices).deepEqual(['A9']);
    should(sink.stops).deepEqual([]);
  });
});
