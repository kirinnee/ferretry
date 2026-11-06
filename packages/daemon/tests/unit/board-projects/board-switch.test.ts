import { describe, it } from 'bun:test';
import should from 'should';
import {
  type BoardSwitchDocument,
  type BoardSwitchMutation,
  BoardSwitchService,
  type BoardSwitchStore,
  switchOf,
} from '../../../src/lib/board-projects/index.ts';
import { DOCS_ID, FERRETRY_ID } from './support.ts';

const NOW = '2026-11-01T12:00:00.000Z';
const RATCHET_ID = '44444444-4444-4444-8444-444444444444';

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

const service = (store = new MemoryStore(), now = NOW) => ({
  store,
  subject: new BoardSwitchService(store, { now: () => now }),
});

describe('the switch document', () => {
  it('should read a board with no entry as off by default', () => {
    // Act + Assert
    should(switchOf({ v: 1, migratedAt: NOW, boards: {} }, DOCS_ID)).deepEqual({
      projectId: DOCS_ID,
      on: false,
      setBy: 'default',
      setAt: null,
    });
  });

  it('should read a stored entry written by the old one-time pass as it was written', () => {
    // Act + Assert
    should(
      switchOf(
        { v: 1, migratedAt: NOW, boards: { [FERRETRY_ID]: { on: true, setBy: 'migration', setAt: NOW } } },
        FERRETRY_ID,
      ),
    ).deepEqual({ projectId: FERRETRY_ID, on: true, setBy: 'migration', setAt: NOW });
  });
});

describe('BoardSwitchService', () => {
  it('should read every board off, writing nothing, in a home with no switch document', async () => {
    // Arrange
    const { subject, store } = service();

    // Act
    const answers = [await subject.isOn(FERRETRY_ID), await subject.isOn(RATCHET_ID)];

    // Assert
    should(answers).deepEqual([false, false]);
    should(store.writes).equal(0);
    should(await subject.read(FERRETRY_ID)).deepEqual({
      projectId: FERRETRY_ID,
      on: false,
      setBy: 'default',
      setAt: null,
    });
  });

  it("should record the owner's switch and leave the other entries as they were", async () => {
    // Arrange
    const store = new MemoryStore();
    store.document = {
      v: 1,
      migratedAt: NOW,
      boards: { [DOCS_ID]: { on: false, setBy: 'migration', setAt: NOW } },
    };
    const { subject } = service(store);

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
    const subject = new BoardSwitchService(empty, { now: () => NOW });

    // Act + Assert
    should(await subject.read(DOCS_ID)).deepEqual({ projectId: DOCS_ID, on: false, setBy: 'default', setAt: null });
    should(await subject.set(DOCS_ID, true)).deepEqual({ projectId: DOCS_ID, on: true, setBy: 'owner', setAt: NOW });
  });
});
