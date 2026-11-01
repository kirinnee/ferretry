import { describe, it } from 'bun:test';
import { type BoardTask, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import {
  type BoardSwitchDocument,
  type BoardSwitchMutation,
  BoardSwitchService,
  type BoardSwitchStore,
  MIGRATION_WINDOW_MS,
  migratedDocument,
  ownerWorkedBoards,
  switchOf,
} from '../../../src/lib/board-projects/index.ts';
import { DOCS_ID, FERRETRY_ID } from './support.ts';

const NOW = '2026-11-01T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();
const RATCHET_ID = '44444444-4444-4444-8444-444444444444';

type Card = Pick<BoardTask, 'projectId' | 'history'>;
type Kind = 'owner' | 'ferret' | 'daemon';

/** A card on `projectId` whose history is one event of `type` by `kind`, `at` ago. */
const worked = (projectId: string, type: string, kind: Kind, at: number): Card =>
  ({
    projectId,
    history: [
      {
        seq: 1,
        type,
        at: ago(at),
        actor: kind === 'ferret' ? { kind, sessionId: 'ms8-abcd1234' } : { kind },
      },
    ],
  }) as unknown as Card;

class MemoryStore implements BoardSwitchStore {
  document: BoardSwitchDocument | null = null;
  writes = 0;

  async read(): Promise<BoardSwitchDocument | null> {
    return this.document;
  }

  async transact<T>(decide: (current: BoardSwitchDocument | null) => BoardSwitchMutation<T>): Promise<T> {
    const mutation = decide(this.document);
    if (mutation.next !== undefined) {
      this.document = mutation.next;
      this.writes += 1;
    }
    return mutation.result;
  }
}

const service = (cards: readonly Card[], store = new MemoryStore(), now = NOW) => ({
  store,
  subject: new BoardSwitchService(
    store,
    { cards: async () => cards, projects: async () => [FERRETRY_ID, DOCS_ID, RATCHET_ID] },
    { now: () => now },
  ),
});

describe('ownerWorkedBoards', () => {
  it('should count what the owner made, moved, reopened or dropped in the window', () => {
    // Arrange
    const since = Date.parse(NOW) - MIGRATION_WINDOW_MS;
    const cards = [
      worked(FERRETRY_ID, 'moved', 'owner', 2 * DAY),
      worked(DOCS_ID, 'reopened', 'owner', 13 * DAY),
      worked(RATCHET_ID, 'dropped', 'owner', DAY),
    ];

    // Act + Assert
    should([...ownerWorkedBoards(cards, since)]).deepEqual([FERRETRY_ID, DOCS_ID, RATCHET_ID]);
    should([...ownerWorkedBoards([worked(DOCS_ID, 'created', 'owner', DAY)], since)]).deepEqual([DOCS_ID]);
  });

  it("should not count a ferret's or the daemon's work, a note, an old act, or the Unfiled board", () => {
    // Arrange
    const since = Date.parse(NOW) - MIGRATION_WINDOW_MS;
    const cards = [
      worked(FERRETRY_ID, 'moved', 'ferret', DAY),
      worked(FERRETRY_ID, 'moved', 'daemon', DAY),
      worked(DOCS_ID, 'note', 'owner', DAY),
      worked(RATCHET_ID, 'moved', 'owner', 15 * DAY),
      worked(UNFILED_PROJECT_ID, 'moved', 'owner', DAY),
    ];

    // Act + Assert
    should([...ownerWorkedBoards(cards, since)]).deepEqual([]);
  });
});

describe('the switch document', () => {
  it('should give every board an entry, Unfiled first, on only where the owner worked', () => {
    // Act
    const document = migratedDocument([FERRETRY_ID, DOCS_ID], new Set([FERRETRY_ID]), NOW);

    // Assert
    should(document).deepEqual({
      v: 1,
      migratedAt: NOW,
      boards: {
        [UNFILED_PROJECT_ID]: { on: false, setBy: 'migration', setAt: NOW },
        [FERRETRY_ID]: { on: true, setBy: 'migration', setAt: NOW },
        [DOCS_ID]: { on: false, setBy: 'migration', setAt: NOW },
      },
    });
  });

  it('should read a board with no entry as off by default', () => {
    // Act + Assert
    should(switchOf({ v: 1, migratedAt: NOW, boards: {} }, DOCS_ID)).deepEqual({
      projectId: DOCS_ID,
      on: false,
      setBy: 'default',
      setAt: null,
    });
  });
});

describe('BoardSwitchService', () => {
  it('should run the one-time pass on the first read, and never again', async () => {
    // Arrange
    const { subject, store } = service([worked(FERRETRY_ID, 'moved', 'owner', DAY)]);

    // Act
    const ferretry = await subject.isOn(FERRETRY_ID);
    const ratchet = await subject.isOn(RATCHET_ID);
    const again = await subject.migrate();

    // Assert
    should([ferretry, ratchet, again]).deepEqual([true, false, null]);
    should(store.writes).equal(1);
    should(await subject.read(FERRETRY_ID)).deepEqual({
      projectId: FERRETRY_ID,
      on: true,
      setBy: 'migration',
      setAt: NOW,
    });
  });

  it('should say which boards the pass switched on and off', async () => {
    // Arrange
    const { subject } = service([worked(DOCS_ID, 'reopened', 'owner', DAY)]);

    // Act
    const migration = await subject.migrate();

    // Assert
    should(migration).deepEqual({
      migratedAt: NOW,
      on: [DOCS_ID],
      off: [UNFILED_PROJECT_ID, FERRETRY_ID, RATCHET_ID],
    });
  });

  it('should decide nothing when another pass got there first', async () => {
    // Arrange: the document appears between the read and the transaction.
    const store = new MemoryStore();
    const racing: BoardSwitchStore = {
      read: async () => null,
      transact: async decide => {
        store.document = migratedDocument([], new Set(), NOW);
        return await store.transact(decide);
      },
    };
    const subject = new BoardSwitchService(
      racing,
      { cards: async () => [], projects: async () => [] },
      { now: () => NOW },
    );

    // Act + Assert
    should(await subject.migrate()).be.null();
    should(store.writes).equal(0);
  });

  it("should record the owner's switch, after the pass", async () => {
    // Arrange
    const { subject, store } = service([]);

    // Act
    const set = await subject.set(RATCHET_ID, true);
    const off = await subject.set(FERRETRY_ID, false);

    // Assert
    should(set).deepEqual({ projectId: RATCHET_ID, on: true, setBy: 'owner', setAt: NOW });
    should(off.on).be.false();
    should(await subject.isOn(RATCHET_ID)).be.true();
    should(store.document?.boards[DOCS_ID]).deepEqual({ on: false, setBy: 'migration', setAt: NOW });
  });

  it('should read off, never on a guess, when the store keeps nothing', async () => {
    // Arrange: a store that writes nothing, and a switch with no document yet.
    const empty: BoardSwitchStore = { read: async () => null, transact: async decide => decide(null).result };
    const subject = new BoardSwitchService(
      empty,
      { cards: async () => [worked(DOCS_ID, 'moved', 'owner', DAY)], projects: async () => [DOCS_ID] },
      { now: () => NOW },
    );

    // Act + Assert
    should(await subject.read(DOCS_ID)).deepEqual({ projectId: DOCS_ID, on: false, setBy: 'default', setAt: null });
    should(await subject.set(DOCS_ID, true)).deepEqual({ projectId: DOCS_ID, on: true, setBy: 'owner', setAt: NOW });
  });
});
