/**
 * A JOURNAL IS FOLDED INTO ITS SCAN ONE RECORD AT A TIME (c58 L26, the idle daemon's boot peak).
 *
 * `readJournal` used to collect every record of a journal into a list, wrap each line again, and only then scan it, so one
 * 200,000-event journal sat in memory several times over during the deep consistency pass. The kernel's `state.lines`
 * is a stream now, and `readJournal` folds each record into the scan as it comes: what is held is the pointers, never
 * the lines. The state port is wrapped to see how far each read goes.
 */
import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { FerretHistoryFiles } from '../../../contract/index.ts';
import type { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { createSessionEvent, encodeSessionEvent } from '../../../daemon/lib/storage/journal.ts';
import { memoryStorage, SESSION_STORE_FILES, sessionConfig, sessionState, T0 } from '../../support/daemon/storage.ts';

const A = parseSessionId('stream-a');
const EVENTS = 5_000;

interface JournalProbe {
  readJournal(id: typeof A): Promise<{
    readonly scan: { readonly events: readonly unknown[]; readonly pointers: readonly unknown[] };
    readonly count: number;
    readonly complete: boolean;
  }>;
}
const probe = (storage: DaemonStorage): JournalProbe => storage as unknown as JournalProbe;

/** How many records each journal read took from the state port, and an optional fault after that many. */
function watching(reads: number[], failAfter?: number) {
  return (port: StatePort): StatePort => ({
    ...port,
    lines: (file, name) => {
      if (file !== FerretHistoryFiles) return port.lines(file, name);
      const inner = port.lines(file, name);
      return (async function* () {
        let taken = 0;
        reads.push(0);
        for await (const record of inner) {
          if (failAfter !== undefined && taken === failAfter) throw new Error('disk fell over');
          taken += 1;
          reads[reads.length - 1] = taken;
          yield record;
        }
      })();
    },
  });
}

/** One session with a large journal, written straight to the state folder (a storage append per event would be slow). */
async function withLargeJournal(reads: number[], failAfter?: number) {
  const folder = new MemoryStateFolder();
  const raw = folder.port(SESSION_STORE_FILES);
  for (let n = 0; n < EVENTS; n++) {
    await raw.append(FerretHistoryFiles, encodeSessionEvent(createSessionEvent(A, n, T0, 'note', { n })), A);
  }
  const made = await memoryStorage({ folder, wrapState: watching(reads, failAfter) });
  await made.storage.writeConfig(A, sessionConfig(A));
  await made.storage.writeState(A, sessionState(A));
  reads.length = 0;
  return made;
}

describe('reading a journal', () => {
  it('should hold its pointers and a count, never its lines or its events', async () => {
    // Arrange
    const reads: number[] = [];
    const { storage } = await withLargeJournal(reads);

    // Act
    const journal = await probe(storage).readJournal(A);

    // Assert — every record was taken from the stream, and none is kept but as a pointer.
    should(reads).eql([EVENTS]);
    should(journal.count).equal(EVENTS);
    should(journal.complete).be.true();
    should(journal.scan.pointers).have.length(EVENTS);
    should(journal.scan.events).have.length(0);
    should(Object.keys(journal)).not.containEql('lines');
  });

  it('should end with a damaged line, and not complete, when the stream fails part way', async () => {
    // Arrange
    const reads: number[] = [];
    const { storage } = await withLargeJournal(reads, 1_200);

    // Act
    const journal = await probe(storage).readJournal(A);

    // Assert — what was read stands, then the fault is the last line, as it always was.
    should(journal.complete).be.false();
    should(journal.count).equal(1_201);
    should(journal.scan.pointers).have.length(1_200);
  });
});

describe('a reconcile of a large journal', () => {
  it('should read the journal through the stream once and index every event', async () => {
    // Arrange
    // A restart, and a line another writer appended behind the storage: the row's version no longer matches, so the
    // deep pass reads the journal.
    const reads: number[] = [];
    const { folder } = await withLargeJournal(reads);
    const { storage } = await memoryStorage({ folder, wrapState: watching(reads) });
    await folder
      .port(SESSION_STORE_FILES)
      .append(FerretHistoryFiles, encodeSessionEvent(createSessionEvent(A, EVENTS, T0, 'note', { behind: 1 })), A);
    reads.length = 0;

    // Act
    const result = await storage.reconcile();

    // Assert
    should(reads).eql([EVENTS + 1]);
    should([result.sessionCount, result.eventCount, result.problems]).eql([1, EVENTS + 1, []]);
    should(storage.findSession(A)?.lastSequence).equal(EVENTS + 1);
  });
});

describe('proving the events a replay names', () => {
  it('should take only as much of the journal as the last line asked for', async () => {
    // Arrange
    const reads: number[] = [];
    const { storage } = await withLargeJournal(reads);
    await storage.reconcile();
    reads.length = 0;

    // Act
    const page = await storage.replay(A, 0, 10);

    // Assert — the replay's own proof reads ten lines (the one before it is the session's sync); the other 4,990 are
    // never taken.
    should(page.events.map(event => event.sequence)).eql([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    should(reads.at(-1)).equal(10);
  });
});
