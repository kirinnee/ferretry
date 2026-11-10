/**
 * BG-049: the session index is rebuilt at boot, in slices, when the cache file was lost.
 *
 * The index is the kernel's `sqlite-cache` (`state/ferrets/index.sqlite`). A cache that is gone — after the conversion
 * from the previous version (which does not carry `sessions.sqlite`), or a format mismatch the kernel dropped — left
 * every reader of `listSessions` with an EMPTY fleet until a fleet-event feed reader connected. `rebuildIndexYielding`
 * is what the boot job `ferrets.index-rebuild` runs: a survey, then the sessions the index lacks, one slice at a time,
 * each session under its own lane, with the loop handed back between slices.
 */
import { describe, expect, test } from 'bun:test';
import { KeyedSerialExecutor } from '../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import { ListedSessionIndex } from '../../../../daemon/adapters/storage/listed-session-index.ts';
import { StateSqliteIndex } from '../../../../daemon/adapters/storage/sqlite-index.ts';
import { FerretIndexFile } from '../../../../contract/index.ts';
import type { SessionIndex } from '../../../../daemon/lib/ports.ts';
import {
  emptyCache,
  generatedFleet as fleet,
  restartWithCacheLost,
  sessionIdAt as idOf,
} from '../../../support/daemon/index-rebuild-world.ts';
import { memoryStorage, SESSION_STORE_FILES, sessionConfig } from '../../../support/daemon/storage.ts';

const COUNT = 60;

const noYield = async (): Promise<void> => {};

describe('the session index after a restart with the cache lost (BG-049)', () => {
  test('equals the one before the restart, event pointers included', async () => {
    const before = await fleet(COUNT);
    const listedBefore = before.storage.listSessions();
    const replayedBefore = await before.storage.replay(idOf(COUNT - 1));
    expect(listedBefore).toHaveLength(COUNT);

    const after = await restartWithCacheLost(before);
    // The state the owner met: nothing listed, though every document is on disk.
    expect(after.storage.listSessions()).toEqual([]);

    const result = await after.storage.rebuildIndexYielding({ sliceSize: 50, yieldToLoop: noYield });

    expect(result).toMatchObject({ surveyed: COUNT, missing: COUNT, rebuilt: COUNT, complete: true });
    expect(after.storage.listSessions()).toEqual(listedBefore);
    expect(await after.storage.replay(idOf(COUNT - 1))).toEqual(replayedBefore);
    await after.storage.close();
  });
});

describe('the rebuild yields between slices (BG-049 bounded gap)', () => {
  test('hands the loop back after every slice, so no pass is one run of O(n) work', async () => {
    const after = await restartWithCacheLost(await fleet(COUNT));
    let yields = 0;
    const slice = 7;

    const result = await after.storage.rebuildIndexYielding({
      sliceSize: slice,
      yieldToLoop: async () => {
        yields += 1;
      },
    });

    expect(result.rebuilt).toBe(COUNT);
    expect(yields).toBeGreaterThanOrEqual(Math.ceil(COUNT / slice));
    expect(result.slices).toBe(Math.ceil(COUNT / slice));
    await after.storage.close();
  });

  test('lists a growing, consistent prefix while it runs: a session is wholly there or not there', async () => {
    const after = await restartWithCacheLost(await fleet(COUNT));
    const seen: number[] = [];

    await after.storage.rebuildIndexYielding({
      sliceSize: 10,
      yieldToLoop: async () => {
        const listed = after.storage.listSessions();
        seen.push(listed.length);
        for (const session of listed) expect(session.lastSequence).toBe(2);
      },
    });

    expect(seen).toEqual([10, 20, 30, 40, 50, 60]);
    await after.storage.close();
  });
});

describe('the rebuild holds no exclusive lock across slices (BG-049)', () => {
  test('a write from another caller between two slices is not blocked for the rest of the rebuild', async () => {
    const lost = await restartWithCacheLost(await fleet(30));
    const outcomes: string[] = [];
    let slice = 0;

    const result = await lost.storage.rebuildIndexYielding({
      sliceSize: 10,
      yieldToLoop: async () => {
        slice += 1;
        if (slice !== 1) return;
        // Between slice 1 and slice 2: a session the rebuild has not reached takes a write, and a new one is created.
        const fresh = idOf(900);
        const write = Promise.all([
          lost.storage.append(idOf(25), 'note', { n: 3 }),
          lost.storage.writeConfig(fresh, sessionConfig(fresh)),
        ]).then(() => 'written');
        const stuck = new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 1_000));
        outcomes.push(await Promise.race([write, stuck]));
      },
    });

    expect(outcomes).toEqual(['written']);
    expect(result.complete).toBe(true);
    const listed = lost.storage.listSessions();
    expect(listed).toHaveLength(31);
    expect(listed.find(session => session.id === idOf(25))?.lastSequence).toBe(3);
    await lost.storage.close();
  });
});

describe('a rebuild with nothing to rebuild (BG-049)', () => {
  test('does nothing when the index already holds every session of the survey: no lane taken, no write, no yield', async () => {
    const world = await fleet(COUNT);
    const writes: string[] = [];
    const watched = (index: SessionIndex): SessionIndex =>
      new Proxy(index, {
        get: (target, property) => {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (/^(replace|refresh|append|remove)/u.test(String(property))) writes.push(String(property));
            return (value as (...rest: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    class CountingSerial extends KeyedSerialExecutor {
      runs = 0;
      override async run<T>(key: string, work: () => Promise<T>): Promise<T> {
        this.runs += 1;
        return await super.run(key, work);
      }
      override async runExclusive<T>(work: () => Promise<T>): Promise<T> {
        this.runs += 1;
        return await super.runExclusive(work);
      }
    }
    const serial = new CountingSerial();
    // The same files AND the same cache: the index the first storage built is handed to the second.
    const shared = new ListedSessionIndex(
      new StateSqliteIndex(world.folder.port(SESSION_STORE_FILES).sqlite(FerretIndexFile)),
    );
    await world.storage.close();
    const again = await memoryStorage({ folder: world.folder, index: () => watched(shared), serial });
    expect(again.storage.listSessions()).toHaveLength(COUNT);
    let yields = 0;

    const result = await again.storage.rebuildIndexYielding({
      sliceSize: 10,
      yieldToLoop: async () => {
        yields += 1;
      },
    });

    expect(result).toMatchObject({ surveyed: COUNT, missing: 0, rebuilt: 0, slices: 0, complete: true });
    expect(writes).toEqual([]);
    expect(serial.runs).toBe(0);
    expect(yields).toBe(0);
  });

  test('rebuilds only the sessions the index lacks', async () => {
    const world = await fleet(COUNT);
    const listed = world.storage.listSessions();
    const lacking = [idOf(3), idOf(41)];
    // Forget two rows, as a partial cache would.
    const index = new ListedSessionIndex(
      new StateSqliteIndex(world.folder.port(SESSION_STORE_FILES).sqlite(FerretIndexFile)),
    );
    for (const id of lacking) index.removeSession(id);
    await world.storage.close();
    const again = await memoryStorage({ folder: world.folder, index: () => index });
    expect(again.storage.listSessions()).toHaveLength(COUNT - 2);

    const result = await again.storage.rebuildIndexYielding({ sliceSize: 50, yieldToLoop: noYield });

    expect(result).toMatchObject({ missing: 2, rebuilt: 2, complete: true });
    expect(again.storage.listSessions()).toEqual(listed);
  });
});

describe('a rebuild stopped part way (BG-049)', () => {
  test('stops at the next session when the daemon stops, leaves the index usable, and the next boot finishes it', async () => {
    const written = await fleet(COUNT);
    await written.storage.close();
    // One cache file for both boots: what the first left in it, the second finds.
    const cache = emptyCache();
    const lost = await memoryStorage({ folder: written.folder, index: () => cache });
    const stop = new AbortController();
    let slices = 0;

    const interrupted = await lost.storage.rebuildIndexYielding({
      sliceSize: 10,
      signal: stop.signal,
      yieldToLoop: async () => {
        slices += 1;
        if (slices === 2) stop.abort();
      },
    });

    expect(interrupted).toMatchObject({ rebuilt: 20, complete: false });
    // Usable: what was rebuilt is whole, and a point read answers for it.
    expect(lost.storage.listSessions()).toHaveLength(20);
    expect(lost.storage.listSessions().every(session => session.lastSequence === 2)).toBe(true);

    // The next boot, on the same cache: it finds the rest missing and finishes.
    expect(cache.listSessions()).toHaveLength(20);
    const next = await memoryStorage({ folder: lost.folder, index: () => cache });
    const finished = await next.storage.rebuildIndexYielding({ sliceSize: 10, yieldToLoop: noYield });

    expect(finished).toMatchObject({ missing: 40, rebuilt: 40, complete: true });
    expect(next.storage.listSessions()).toHaveLength(COUNT);
  });

  test('does not start when it was already stopped', async () => {
    const lost = await restartWithCacheLost(await fleet(5));
    const stop = new AbortController();
    stop.abort();

    const result = await lost.storage.rebuildIndexYielding({ sliceSize: 2, signal: stop.signal, yieldToLoop: noYield });

    expect(result).toMatchObject({ rebuilt: 0, complete: false });
    expect(lost.storage.listSessions()).toEqual([]);
  });
});

describe('a session written during the rebuild (BG-049)', () => {
  test('is neither lost nor duplicated: the rebuild takes each session under its own lane', async () => {
    const serial = new KeyedSerialExecutor();
    const lost = await restartWithCacheLost(await fleet(10), serial);
    const held = idOf(3);
    const written = idOf(8);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    // A writer already holds the lane of `held`.
    const writer = serial.run(held, async () => await gate);

    const rebuild = lost.storage.rebuildIndexYielding({ sliceSize: 3, yieldToLoop: noYield });
    await new Promise(resolve => setTimeout(resolve, 20));
    // The rebuild waits behind that writer: `held` is not indexed by anything outside its lane.
    expect(lost.storage.listSessions().map(session => session.id)).not.toContain(held);

    // A session the rebuild has not reached yet takes a third event, through the ordinary write path.
    await lost.storage.append(written, 'note', { n: 3 });
    release();
    await writer;
    const result = await rebuild;

    expect(result.complete).toBe(true);
    const listed = lost.storage.listSessions();
    expect(listed.map(session => session.id).sort()).toEqual(Array.from({ length: 10 }, (_, at) => idOf(at)).sort());
    expect(new Set(listed.map(session => session.id)).size).toBe(10);
    expect(listed.find(session => session.id === written)?.lastSequence).toBe(3);
    expect(listed.find(session => session.id === held)?.lastSequence).toBe(2);
    await lost.storage.close();
  });
});
