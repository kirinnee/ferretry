import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { FerretHistoryFiles, FerretIndexFile } from '../../../contract/index.ts';
import { ListedSessionIndex } from '../../../daemon/adapters/storage/listed-session-index.ts';
import { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import { StateSqliteIndex } from '../../../daemon/adapters/storage/sqlite-index.ts';
import type { SessionIndex } from '../../../daemon/lib/ports.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { SessionConfigFiles, SessionStateFiles } from '../../../daemon/lib/state.ts';
import { RecordingLog, SESSION_STORE_FILES, sessionConfig, sessionState } from '../../support/daemon/storage.ts';

/** Misbehaves on cue, at the exact read where a concurrent writer would land. */
interface Disturbance {
  /** Session names whose document reads throw, as an unreadable file would. */
  readonly unreadable: Set<string>;
  /** While set, every journal read hands back each event with a type no earlier read gave: nothing is provable. */
  restless: boolean;
}

function disturbedPort(folder: MemoryStateFolder, disturbance: Disturbance): StatePort {
  const real = folder.port(SESSION_STORE_FILES);
  let reads = 0;
  return {
    ...real,
    read: async (file, name) => {
      if (name !== undefined && disturbance.unreadable.has(name)) throw new Error(`cannot read ${name}`);
      return await real.read(file, name);
    },
    lines: (file, name) =>
      (async function* () {
        reads += 1;
        for await (const value of real.lines(file, name))
          yield disturbance.restless ? ({ ...(value as object), type: `restless-${String(reads)}` } as never) : value;
      })(),
  };
}

/** An index that, on cue, lets the state change under a fleet listing or drops everything it lists. */
class DisturbedIndex {
  forgetAfterListings = Number.POSITIVE_INFINITY;
  /** Runs once, synchronously, as the next fleet listing is taken. */
  beforeNextListing: (() => void) | undefined;

  wrap(index: SessionIndex): SessionIndex {
    let listings = 0;
    return new Proxy(index, {
      get: (target, property) => {
        if (property === 'listSessions') {
          return () => {
            const disturb = this.beforeNextListing;
            this.beforeNextListing = undefined;
            disturb?.();
            return ++listings > this.forgetAfterListings ? [] : target.listSessions();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

async function openStorage(options: { readonly index?: DisturbedIndex } = {}) {
  const folder = new MemoryStateFolder();
  const disturbance: Disturbance = { unreadable: new Set(), restless: false };
  const state = disturbedPort(folder, disturbance);
  const start = Date.parse('2026-07-30T12:00:00.000Z');
  let tick = 0;
  const index = new ListedSessionIndex(new StateSqliteIndex(folder.port(SESSION_STORE_FILES).sqlite(FerretIndexFile)));
  const storage = new DaemonStorage(
    state,
    { now: () => new Date(start + tick++ * 1_000).toISOString() },
    new RecordingLog(),
    options.index?.wrap(index) ?? index,
  );
  await storage.loadArchive();
  return { storage, folder, disturbance, raw: folder.port(SESSION_STORE_FILES) };
}

async function capturedError(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Rewrites a session's journal text in place. */
function rewriteJournal(folder: MemoryStateFolder, id: string, transform: (text: string) => string): void {
  folder.plant(FerretHistoryFiles, transform(folder.raw(FerretHistoryFiles, id) ?? ''), id);
}

describe('session storage — names that are not sessions', () => {
  it('should treat a session with no files as nothing to index', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('bare-directory');

    // Act
    const result = await opened.storage.syncSession(id);

    // Assert
    should(result).deepEqual({ sessionCount: 0, eventCount: 0, problems: [] });
    should(opened.storage.findSession(id)).be.undefined();
  });

  it('should report a name that is not a session id, in a rebuild and in a reconcile', async () => {
    // Arrange
    const opened = await openStorage();
    const kept = parseSessionId('kept-session');
    await opened.storage.writeState(kept, sessionState(kept));
    await opened.raw.write(SessionStateFiles, sessionState('stranger') as never, 'Not A Session!');
    const expected = [{ line: 0, byteOffset: 0, message: 'invalid session directory "Not A Session!"' }];

    // Act
    const rebuild = await opened.storage.rebuildIndex();
    const reconcile = await opened.storage.reconcile();

    // Assert
    for (const result of [rebuild, reconcile]) {
      should(result.sessionCount).equal(1);
      should(result.problems.map(({ line, byteOffset, message }) => ({ line, byteOffset, message }))).deepEqual(
        expected,
      );
      should(result.problems[0]?.file).equal('Not A Session!');
    }
  });

  it('should skip a session whose documents cannot be read, and keep reconciling the others', async () => {
    // Arrange
    const opened = await openStorage();
    const kept = parseSessionId('kept-session');
    const broken = parseSessionId('broken-read');
    await opened.storage.writeState(kept, sessionState(kept));
    await opened.raw.write(SessionStateFiles, sessionState(broken) as never, broken);
    opened.disturbance.unreadable.add(broken);

    // Act
    const result = await opened.storage.reconcile();

    // Assert
    should(result.sessionCount).equal(1);
    should(result.failedSessionIds).deepEqual([broken]);
    should(result.problems).have.length(1);
    should(result.problems[0]?.file).equal(broken);
    should(result.problems[0]?.message).startWith(`session ${broken} failed to read and was skipped: `);
    should(opened.storage.findSession(kept)?.id).equal(kept);
  });

  it('should forget a session whose config and state are gone and keep serving an empty replay', async () => {
    // Arrange — no document and no journal is left, which is no session at all.
    const opened = await openStorage();
    const id = parseSessionId('reduced-to-nothing');
    await opened.storage.writeConfig(id, sessionConfig(id, { name: 'gone soon' }));
    await opened.raw.remove(SessionConfigFiles, id);

    // Act
    const replay = await opened.storage.replay(id);

    // Assert
    should(replay.events).deepEqual([]);
    should(opened.storage.findSession(id)).be.undefined();
  });

  it('should report a damaged document as a problem and still index the session from its journal', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('damaged-state');
    await opened.storage.append(id, 'first', {});
    opened.folder.plant(SessionStateFiles, '{ torn', id);

    // Act
    const result = await opened.storage.rebuildIndex();

    // Assert
    should(result.sessionCount).equal(1);
    should(result.problems.map(problem => problem.file)).deepEqual([`${id}/state.json`]);
    should(opened.storage.findSession(id)?.lastSequence).equal(1);
  });
});

describe('session storage — a journal that grew outside the index', () => {
  it('should index the new lines from a tail scan', async () => {
    // Arrange — the index knows one event; a second landed in the journal without it.
    const opened = await openStorage();
    const id = parseSessionId('moving-tail');
    const first = await opened.storage.append(id, 'first', {});
    await opened.raw.append(FerretHistoryFiles, { ...first, sequence: 2, type: 'second' }, id);

    // Act
    const result = await opened.storage.reconcile();

    // Assert
    should(result.sessionCount).equal(1);
    should(result.eventCount).equal(2);
    should(result.problems).deepEqual([]);
    should(opened.storage.findSession(id)?.lastSequence).equal(2);
  });

  it('should drop a session whose documents are gone before a reconcile', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('vanishing-session');
    await opened.storage.writeConfig(id, sessionConfig(id, { name: 'vanishing' }));
    await opened.raw.remove(SessionConfigFiles, id);

    // Act
    const result = await opened.storage.reconcile();

    // Assert
    should(result.sessionCount).equal(0);
    should(result.problems).deepEqual([]);
    should(opened.storage.findSession(id)).be.undefined();
  });

  it('should rescan when the last indexed event was replaced by a different one', async () => {
    // Arrange — the journal grew past what the index knows AND its last known record is no longer the same event.
    const opened = await openStorage();
    const id = parseSessionId('overwritten-record');
    const first = await opened.storage.append(id, 'first', {});
    rewriteJournal(opened.folder, id, text => text.replace('"type":"first"', '"type":"other"'));
    await opened.raw.append(FerretHistoryFiles, { ...first, sequence: 2, type: 'second' }, id);

    // Act
    const result = await opened.storage.reconcile();

    // Assert — a full rescan, not a trusting tail scan from the stale pointer.
    should(result.sessionCount).equal(1);
    should(opened.storage.findSession(id)?.lastSequence).equal(2);
    should((await opened.storage.replay(id)).events.map(event => event.type)).deepEqual(['other', 'second']);
  });
});

describe('session storage — a session that never had a journal', () => {
  it('should keep it indexed without a journal across a reconcile, and replay it as empty', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('eventless');
    await opened.raw.write(SessionStateFiles, sessionState(id) as never, id);
    await opened.storage.rebuildIndex();

    // Act
    const reconcile = await opened.storage.reconcile();
    const replay = await opened.storage.replay(id);

    // Assert
    should(reconcile).deepEqual({ sessionCount: 1, eventCount: 0, problems: [] });
    should(opened.storage.findSession(id)?.journal).be.null();
    should(replay.events).deepEqual([]);
  });

  it('should refuse a session whose indexed journal has vanished', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('lost-journal');
    await opened.storage.writeState(id, sessionState(id));
    await opened.storage.append(id, 'first', {});
    await opened.raw.remove(FerretHistoryFiles, id);

    // Act
    const write = await capturedError(async () => await opened.storage.writeState(id, sessionState(id)));
    const survey = await opened.storage.surveySessionDirectories();
    const rebuild = await opened.storage.rebuildIndex();

    // Assert
    should((write as Error).name).equal('MissingSessionJournalError');
    should(survey).deepEqual([{ id, journalLost: true }]);
    should(rebuild.lostJournalSessionIds).deepEqual([id]);
  });
});

describe('session storage — replay and fleet tail', () => {
  it('should refuse replay arguments that are not whole, bounded numbers', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('bounded-replay');

    // Act
    const negative = await capturedError(async () => await opened.storage.replay(id, -1));
    const fractional = await capturedError(async () => await opened.storage.replay(id, 0.5));
    const empty = await capturedError(async () => await opened.storage.replay(id, 0, 0));
    const huge = await capturedError(async () => await opened.storage.replay(id, 0, 10_001));

    // Assert
    should(String(negative)).containEql('afterSequence must be a non-negative integer');
    should(String(fractional)).containEql('afterSequence must be a non-negative integer');
    should(String(empty)).containEql('limit must be an integer between 1 and 10000');
    should(String(huge)).containEql('limit must be an integer between 1 and 10000');
  });

  it('should page a replay by sequence', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('paged-replay');
    for (const type of ['one', 'two', 'three']) await opened.storage.append(id, type, {});

    // Act
    const first = await opened.storage.replay(id, 0, 2);
    const second = await opened.storage.replay(id, first.nextSequence, 2);

    // Assert
    should(first.events.map(event => event.type)).deepEqual(['one', 'two']);
    should(first.hasMore).be.true();
    should(first.nextSequence).equal(2);
    should(second.events.map(event => event.sequence)).deepEqual([3]);
    should(second.hasMore).be.false();
  });

  it('should re-index and serve a replay whose indexed record changed type', async () => {
    // Arrange — same line count, so only a proof of the pointer against its line can notice.
    const opened = await openStorage();
    const id = parseSessionId('retyped-record');
    await opened.storage.append(id, 'aaaa', {});
    await opened.storage.append(id, 'last', {});
    rewriteJournal(opened.folder, id, text => text.replace('"type":"aaaa"', '"type":"bbbb"'));

    // Act
    const replay = await opened.storage.replay(id);

    // Assert
    should(replay.events.map(event => event.type)).deepEqual(['bbbb', 'last']);
  });

  it('should refuse a replay that stays unprovable after re-indexing', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('unprovable-replay');
    await opened.storage.append(id, 'first', {});
    opened.disturbance.restless = true;

    // Act
    const error = await capturedError(async () => await opened.storage.replay(id));

    // Assert
    should(String(error)).containEql(`event index for ${id} is inconsistent after re-indexing`);
  });

  it('should re-index only the tail sessions when a tail record changed type, then serve the fleet tail', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('retyped-tail');
    await opened.storage.append(id, 'aaaa', {});
    await opened.storage.append(id, 'last', {});
    rewriteJournal(opened.folder, id, text => text.replace('"type":"aaaa"', '"type":"bbbb"'));

    // Act
    const tail = await opened.storage.tailEvents();

    // Assert
    should(tail.map(event => event.type)).deepEqual(['bbbb', 'last']);
  });

  it('should refuse a fleet tail that stays unprovable after re-indexing', async () => {
    // Arrange
    const opened = await openStorage();
    await opened.storage.append(parseSessionId('unprovable-tail'), 'first', {});
    opened.disturbance.restless = true;

    // Act
    const error = await capturedError(async () => await opened.storage.tailEvents());

    // Assert
    should(String(error)).containEql('fleet event index is inconsistent after re-indexing');
  });

  it('should refuse a fleet whose index no longer matches the sessions it just synchronized', async () => {
    // Arrange
    const index = new DisturbedIndex();
    const opened = await openStorage({ index });
    await opened.storage.append(parseSessionId('forgotten-session'), 'first', {});
    index.forgetAfterListings = 0;

    // Act
    const error = await capturedError(async () => await opened.storage.fleetSessionIds());

    // Assert
    should(String(error)).containEql('the fleet index does not exactly match its durable session directories');
  });

  it('should name a session that stopped being one between the survey and its synchronization', async () => {
    // Arrange — surveyed with a config, then left with nothing as the survey is read back.
    const index = new DisturbedIndex();
    const opened = await openStorage({ index });
    const id = parseSessionId('stopped-being-a-session');
    await opened.storage.writeConfig(id, sessionConfig(id, { name: 'fleeting' }));
    index.beforeNextListing = () => opened.folder.files.delete(`${id}/config.json`);

    // Act
    const error = await capturedError(async () => await opened.storage.fleetSessionIds());

    // Assert
    should(String(error)).containEql(`session ${id} has durable directory evidence but could not be indexed`);
  });
});

describe('session storage — holding several sessions still', () => {
  it('should hold the lanes of every named session while the work reads them, then release them', async () => {
    // Arrange
    const { storage } = await openStorage();
    const one = parseSessionId('held-one');
    const two = parseSessionId('held-two');
    const other = parseSessionId('not-held');
    await storage.writeState(one, sessionState(one));
    await storage.writeState(two, sessionState(two));
    await storage.writeState(other, sessionState(other));
    const order: string[] = [];
    let release = (): void => undefined;
    const finish = new Promise<void>(done => {
      release = done;
    });
    let proceed = (): void => undefined;
    const started = new Promise<void>(resolve => {
      proceed = resolve;
    });

    // Act — a write to a held session queued while the hold is open lands only after the work.
    const held = storage.holdSessions([one, two], async () => {
      proceed();
      await finish;
      order.push('work');
      return await storage.readState(one);
    });
    await started;
    const later = storage
      .writeState(two, sessionState(two, { status: 'completed' }))
      .then(() => void order.push('later write'));
    await storage.writeState(other, sessionState(other, { status: 'completed' }));
    order.push('other write');
    release();
    const seen = await held;
    await later;

    // Assert
    should(seen).eql(sessionState(one));
    should(order).eql(['other write', 'work', 'later write']);
    should(await storage.readState(two)).eql(sessionState(two, { status: 'completed' }));
  });

  it('should release the lanes when the work throws, and refuse a hold on a closed storage', async () => {
    // Arrange
    const { storage } = await openStorage();
    const id = parseSessionId('held-and-failed');
    await storage.writeState(id, sessionState(id));

    // Act
    const failed = await capturedError(
      async () =>
        await storage.holdSessions([id], async () => {
          throw new Error('boom');
        }),
    );
    await storage.writeState(id, sessionState(id, { status: 'completed' }));
    await storage.close();
    const refused = await capturedError(async () => await storage.holdSessions([id], async () => 'never'));

    // Assert
    should((failed as Error).message).equal('boom');
    should(refused).be.an.Error();
  });
});
