import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { FerretHistoryFiles, FerretIndexFile, FerretStateFile } from '../../../contract/index.ts';
import { ListedSessionIndex } from '../../../daemon/adapters/storage/listed-session-index.ts';
import { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import { StateSqliteIndex } from '../../../daemon/adapters/storage/sqlite-index.ts';
import type { SessionIndex } from '../../../daemon/lib/ports.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import type { SessionEvent } from '../../../daemon/lib/storage-types.ts';
import { RecordingLog, SESSION_STORE_FILES, sessionState } from '../../support/daemon/storage.ts';

/** Replaces named members of a session index, so a test can fail the exact call it is about. */
type IndexOverrides = { -readonly [K in keyof SessionIndex]?: SessionIndex[K] };

interface Options {
  /** Wraps the state port, to fail a read on cue. */
  readonly wrapState?: (port: StatePort) => StatePort;
  /** Overrides members of the session index; each override receives the real index. */
  readonly index?: (real: SessionIndex) => IndexOverrides;
}

/** Journals that stop being readable after this many records, as a read torn by a failing disk would. */
const tornAfter = new Map<string, number>();

function tearing(port: StatePort): StatePort {
  return {
    ...port,
    lines: (file, name) =>
      (async function* () {
        const limit = name === undefined ? undefined : tornAfter.get(name);
        let seen = 0;
        for await (const record of port.lines(file, name)) {
          if (limit !== undefined && seen++ >= limit) break;
          yield record;
        }
        if (limit !== undefined) throw new Error('torn read');
      })(),
  } as StatePort;
}

async function openStorage(options: Options = {}) {
  const folder = new MemoryStateFolder();
  const raw = folder.port(SESSION_STORE_FILES);
  const start = Date.parse('2026-07-30T12:00:00.000Z');
  let tick = 0;
  const real = new ListedSessionIndex(new StateSqliteIndex(raw.sqlite(FerretIndexFile)));
  const overrides = options.index?.(real) ?? {};
  const index = new Proxy(real as SessionIndex, {
    get: (target, property) => {
      const override = (overrides as Record<string | symbol, unknown>)[property];
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const storage = new DaemonStorage(
    options.wrapState?.(tearing(raw)) ?? tearing(raw),
    { now: () => new Date(start + tick++ * 1_000).toISOString() },
    new RecordingLog(),
    index,
  );
  await storage.loadArchive();
  return { storage, folder, raw, real };
}

async function captured(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('session storage — the journal and what listens to it', () => {
  it('should hand each durable append to its listeners, survive a listener that throws, and stop after unsubscribe', async () => {
    const { storage } = await openStorage();
    const id = parseSessionId('listened');
    const heard: SessionEvent[] = [];
    storage.subscribeEvents(() => {
      throw new Error('a broken peer');
    });
    const stop = storage.subscribeEvents(event => heard.push(event));

    const first = await storage.append(id, 'first', {});
    stop();
    await storage.append(id, 'second', {});

    should(first.sequence).equal(1);
    should(heard.map(event => event.type)).deepEqual(['first']);
  });

  it('should prove a journal is present, and refuse a session whose journal is lost', async () => {
    const { storage, raw } = await openStorage();
    const withJournal = parseSessionId('has-journal');
    const without = parseSessionId('no-journal');
    await storage.append(withJournal, 'first', {});
    await raw.write(FerretStateFile, sessionState(without) as never, without);

    await storage.assertJournalReadable(withJournal);
    const lost = await captured(async () => await storage.assertJournalReadable(without));

    should((lost as Error).name).equal('MissingSessionJournalError');
    should((lost as Error).message).containEql(`session ${without} has lost its durable journal`);
  });

  it('should count a journal it cannot read as present rather than lost', async () => {
    const { storage } = await openStorage({
      wrapState: port => ({
        ...port,
        lines: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('unreadable')) }) }),
      }),
    });

    should(
      await captured(async () => await storage.assertJournalReadable(parseSessionId('unreadable'))),
    ).be.undefined();
  });

  it('should refuse to append after a journal that could not be read to its end', async () => {
    const { storage, folder } = await openStorage({
      wrapState: port => ({
        ...port,
        lines: (file, name) =>
          (async function* () {
            if (name === 'half-read') throw new Error('torn read');
            yield* port.lines(file, name);
          })(),
      }),
    });
    const id = parseSessionId('half-read');
    folder.plant(FerretHistoryFiles, '{"anything":1}\n', id);

    const error = await captured(async () => await storage.append(id, 'next', {}));

    should(String(error)).containEql('could not be read to its end; refusing to append');
  });

  it("should reserve a session directory in the session's lane without writing anything", async () => {
    const { storage, folder } = await openStorage();
    const id = parseSessionId('reserved');

    await storage.reserveSessionDirectory(id);

    should([...folder.files.keys()].filter(name => name.startsWith(`${id}/`))).deepEqual([]);
    should(storage.findSession(id)).be.undefined();
  });
});

describe('session storage — an index that fails while an event is already durable', () => {
  it('should repair the index from the journal and still return the event', async () => {
    let failures = 1;
    const { storage } = await openStorage({
      index: real => ({
        appendEvent: (session, pointer) => {
          if (failures-- > 0) throw new Error('index busy');
          real.appendEvent(session, pointer);
        },
      }),
    });
    const id = parseSessionId('repaired');

    const event = await storage.append(id, 'first', {});

    should(event.sequence).equal(1);
    should(storage.findSession(id)?.lastSequence).equal(1);
    should((await storage.replay(id)).events.map(item => item.type)).deepEqual(['first']);
  });

  it('should say the event is durable when the index cannot be repaired either', async () => {
    const { storage } = await openStorage({
      index: () => ({
        appendEvent: () => {
          throw new Error('index busy');
        },
        replaceSession: () => {
          throw new Error('index gone');
        },
      }),
    });
    const id = parseSessionId('unrepaired');

    const error = (await captured(async () => await storage.append(id, 'first', {}))) as Error & {
      durable?: boolean;
      sessionId?: string;
    };

    should(error.name).equal('DurableEventIndexError');
    should(error.durable).be.true();
    should(error.sessionId).equal(id);
    should(error.message).containEql('is durable in the journal but could not be indexed');
    should(String((error.cause as Error).message)).equal('index busy');
  });
});

describe('session storage — the index sweep and the survey', () => {
  it('should still index a session whose only trace is a journal that could not be read, naming the problem', async () => {
    const { storage, folder } = await openStorage();
    const id = parseSessionId('only-damage');
    folder.plant(FerretHistoryFiles, '', id);
    tornAfter.set(id, 0);

    const result = await storage.syncSession(id);
    tornAfter.clear();

    should(result.sessionCount).equal(1);
    should(result.eventCount).equal(0);
    should(result.problems).have.length(1);
    should(result.problems[0]?.message).containEql('event record could not be read: torn read');
    should(storage.findSession(id)?.lastSequence).equal(0);
  });

  it('should skip a session whose index write fails, name it, and keep reconciling', async () => {
    const { storage, raw } = await openStorage({
      index: real => ({
        replaceSession: (session, events) => {
          if (session.id === 'breaks') throw new Error('index full');
          real.replaceSession(session, events);
        },
      }),
    });
    const fine = parseSessionId('fine');
    const breaks = parseSessionId('breaks');
    await raw.write(FerretStateFile, sessionState(fine) as never, fine);
    await raw.write(FerretStateFile, sessionState(breaks) as never, breaks);

    const result = await storage.reconcile();

    should(result.sessionCount).equal(1);
    should(result.failedSessionIds).deepEqual([breaks]);
    should(result.problems.map(problem => problem.message)).deepEqual([
      `session ${breaks} failed to reconcile and was skipped: index full`,
    ]);
    should(storage.findSession(fine)).not.be.undefined();
  });

  it('should keep only the problems that lie in the new tail when it scans a grown journal', async () => {
    const { storage, raw } = await openStorage();
    const id = parseSessionId('grown-with-damage');
    const first = await storage.append(id, 'first', {});
    await raw.append(FerretHistoryFiles, { ...first, sequence: 2, type: 'second' }, id);
    tornAfter.set(id, 2);

    const result = await storage.reconcile();
    tornAfter.clear();

    should(result.problems).have.length(1);
    should(result.problems[0]?.line).equal(3);
    should(result.problems[0]?.message).containEql('torn read');
    should(storage.findSession(id)?.lastSequence).equal(2);
  });

  it('should append to a session that has documents but was never indexed', async () => {
    const { storage, raw } = await openStorage();
    const id = parseSessionId('unindexed');
    await raw.write(FerretStateFile, sessionState(id) as never, id);

    const event = await storage.append(id, 'first', {});

    should(event.sequence).equal(1);
    should(storage.findSession(id)?.lastSequence).equal(1);
  });

  it('should list the ids on disk and forget one from the index only', async () => {
    const { storage } = await openStorage();
    const a = parseSessionId('aaa-session');
    const b = parseSessionId('bbb-session');
    await storage.append(b, 'first', {});
    await storage.append(a, 'first', {});

    should(await storage.sessionIdsOnDisk()).deepEqual([a, b]);
    storage.forgetFromIndex(a);

    should(storage.findSession(a)).be.undefined();
    should(await storage.sessionIdsOnDisk()).deepEqual([a, b]);
  });
});

describe('session storage — the fleet backlog and its refusals', () => {
  it('should answer nothing when no reader is left, and only the sessions for a limit of zero', async () => {
    const { storage } = await openStorage();
    const id = parseSessionId('backlogged');
    await storage.append(id, 'first', {});

    should(await storage.fleetBacklog(5, () => false)).be.undefined();
    should(await storage.fleetBacklog(0, () => true)).deepEqual({ sessionIds: [id], events: [] });
    const full = await storage.fleetBacklog(5, () => true);
    should(full?.sessionIds).deepEqual([id]);
    should(full?.events.map(event => event.type)).deepEqual(['first']);
  });

  it('should refuse a tail limit that is not a whole number between 1 and 10000', async () => {
    const { storage } = await openStorage();

    for (const limit of [-1, 10_001, 1.5, Number.NaN]) {
      const error = await captured(async () => await storage.fleetBacklog(limit, () => true));
      should(String(error)).containEql('fleet event limit must be an integer between 1 and 10000');
    }
    should(String(await captured(async () => await storage.tailEvents(0)))).containEql('fleet event limit');
  });

  it('should refuse a fleet that lists a session with no directory left on disk', async () => {
    const { storage, folder } = await openStorage();
    const id = parseSessionId('erased');
    await storage.append(id, 'first', {});
    for (const name of [...folder.files.keys()]) if (name.startsWith(`${id}/`)) folder.files.delete(name);

    const error = await captured(async () => await storage.fleetSessionIds());

    should(String(error)).containEql(`session ${id} is indexed but has no readable durable directory evidence`);
  });

  it('should refuse a fleet that lists a session whose journal has been lost', async () => {
    const { storage, raw } = await openStorage();
    const id = parseSessionId('journal-lost');
    await storage.writeState(id, sessionState(id));
    await storage.append(id, 'first', {});
    await raw.remove(FerretHistoryFiles, id);

    const error = (await captured(async () => await storage.fleetSessionIds())) as Error;

    should(error.name).equal('MissingSessionJournalError');
  });

  it('should refuse a tail whose event count falls short of the sequence its session claims', async () => {
    const { storage } = await openStorage({ index: () => ({ countEvents: () => 0 }) });
    await storage.append(parseSessionId('short-counted'), 'first', {});

    const error = await captured(async () => await storage.tailEvents(5));

    should(String(error)).containEql('does not completely represent its durable journal');
  });
});
