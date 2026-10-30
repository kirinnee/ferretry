import { describe, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BigIntStats, FSWatcher } from 'node:fs';
import { rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import {
  BunFileEventSource,
  type FsWatchPrimitives,
  unrefFileEventTimers,
} from '../../../src/adapters/file-events/bun-file-event-source.ts';
import { FileEventHub } from '../../../src/lib/file-events/hub.ts';
import { armed, describeRealFileEvents, hubOver, until, workspace } from './real-file-system.ts';

describeRealFileEvents("Bun's fs.watch", () => new BunFileEventSource());

const DIRECTORY = {
  isDirectory: () => true,
  ino: 1n,
  birthtimeNs: 1n,
  size: 0n,
  mtimeNs: 0n,
} as unknown as BigIntStats;

/** Primitives that refuse with `code`, at the stat or at the watch. */
const refusing = (code: string, at: 'stat' | 'watch'): FsWatchPrimitives => {
  const error = Object.assign(new Error(`${code}: refused`), { code });
  return {
    statSync: () => {
      if (at === 'stat') throw error;
      return DIRECTORY;
    },
    watch: () => {
      throw error;
    },
    stat: async () => await Promise.reject(error),
  };
};

describe('BunFileEventSource', () => {
  it('should classify why a directory cannot be watched', () => {
    // Arrange
    const cases = [
      ['ENOENT', 'stat'],
      ['ENOTDIR', 'stat'],
      ['EMFILE', 'watch'],
      ['ENOSPC', 'watch'],
      ['ENOSYS', 'watch'],
      ['EACCES', 'stat'],
    ] as const;

    // Act
    const opened = cases.map(([code, at]) =>
      new BunFileEventSource(refusing(code, at)).watch(
        '/d',
        () => {},
        () => {},
      ),
    );
    const uncoded = new BunFileEventSource({
      ...refusing('EACCES', 'watch'),
      watch: () => {
        throw 'not an error';
      },
    }).watch(
      '/d',
      () => {},
      () => {},
    );

    // Assert
    should(opened).deepEqual([
      { kind: 'missing' },
      { kind: 'missing' },
      { kind: 'unavailable', reason: 'limit', detail: 'EMFILE: refused' },
      { kind: 'unavailable', reason: 'limit', detail: 'ENOSPC: refused' },
      { kind: 'unavailable', reason: 'unsupported', detail: 'ENOSYS: refused' },
      { kind: 'unavailable', reason: 'failed', detail: 'EACCES: refused' },
    ]);
    should(uncoded).deepEqual({ kind: 'unavailable', reason: 'failed', detail: 'not an error' });
  });

  it('should treat a path that is a file, not a directory, as no directory', async () => {
    // Arrange
    const file = join(await workspace(), 'not-a-directory');
    await writeFile(file, 'x');

    // Act
    const opened = new BunFileEventSource().watch(
      file,
      () => {},
      () => {},
    );

    // Assert
    should(opened).deepEqual({ kind: 'missing' });
  });

  it('should report a watch that dies, and nothing once it was closed', () => {
    // Arrange
    const emitter = new EventEmitter() as EventEmitter & { close(): void };
    let closed = 0;
    emitter.close = () => {
      closed += 1;
    };
    const failures: string[] = [];
    const source = new BunFileEventSource({
      ...refusing('EACCES', 'watch'),
      watch: () => emitter as unknown as FSWatcher,
    });
    const opened = source.watch(
      '/d',
      () => {},
      detail => failures.push(detail),
    );

    // Act
    emitter.emit('error', new Error('the watch went away'));
    if (opened.kind === 'watching') opened.handle.close();
    emitter.emit('error', new Error('after close'));

    // Assert
    should(opened.kind).equal('watching');
    should(failures).deepEqual(['the watch went away']);
    should(closed).equal(1);
  });

  it('should stamp a file by inode, birth, size and modification time, and answer nothing for a missing one', async () => {
    // Arrange
    const directory = await workspace();
    const file = join(directory, 'f');
    await writeFile(file, 'four');
    const source = new BunFileEventSource();

    // Act
    const stamped = await source.stamp(file);
    const missing = await source.stamp(join(directory, 'nope'));

    // Assert
    const stats = await stat(file, { bigint: true });
    should(stamped).deepEqual({ ino: stats.ino, birthNs: stats.birthtimeNs, size: 4n, mtimeNs: stats.mtimeNs });
    should(missing).be.undefined();
  });

  it('should report every name on macOS, where FSEvents filters none, and drop . and ~ names elsewhere', () => {
    // Arrange
    const names = ['session.jsonl', '.credentials.json', '~lock', ''];

    // Act
    const mac = new BunFileEventSource(undefined, 'darwin');
    const linux = new BunFileEventSource(undefined, 'linux');

    // Assert
    should(names.map(name => mac.reports(name))).deepEqual([true, true, true, false]);
    should(names.map(name => linux.reports(name))).deepEqual([true, false, false, false]);
    should(mac.reportsRemoval()).be.false();
  });

  it.if(process.platform !== 'darwin')('should poll a name Bun drops here, and name it as a limitation', async () => {
    // Arrange
    const source = new BunFileEventSource();
    const file = join(await workspace(), '~lock');
    const hub = hubOver(source);

    // Act
    const subscription = hub.subscribe(file, () => {});

    // Assert
    should(subscription.live()).be.false();
    should(hub.fallbacks().map(fallback => fallback.reason)).deepEqual(['unreported-name']);
  });

  // ON A REAL MAC ONLY (the macOS CI job): the claim the owner's daemon rests on.
  it.if(process.platform === 'darwin')(
    "should hear Claude's .credentials.json refreshed in place and by a rename, polling nothing",
    async () => {
      // Arrange: no poll can fire inside this test, so only an FSEvents event can deliver.
      const directory = await workspace();
      const credentials = join(directory, '.credentials.json');
      await writeFile(credentials, '{"token":1}');
      const hub = new FileEventHub(new BunFileEventSource(), unrefFileEventTimers, { settleMs: 10, pollMs: 60_000 });
      const heard: string[] = [];
      const subscription = hub.subscribe(credentials, path => heard.push(path));
      try {
        await armed(hub, directory);
        await Bun.sleep(100);
        heard.length = 0;

        // Act
        await writeFile(credentials, '{"token":2}');
        await until(() => heard.length > 0, 'an in-place refresh');
        await Bun.sleep(100);
        heard.length = 0;
        await writeFile(join(directory, '.credentials.json.tmp'), '{"token":3}');
        await rename(join(directory, '.credentials.json.tmp'), credentials);
        await until(() => heard.length > 0, 'a refresh by rename');

        // Assert
        should(subscription.live()).be.true();
        should(hub.fallbacks()).deepEqual([]);
      } finally {
        hub.close();
      }
    },
  );

  it('should run unreferenced timers that can be cleared', async () => {
    // Arrange
    let fired = 0;

    // Act
    unrefFileEventTimers.setTimeout(() => {
      fired += 1;
    }, 1);
    const cleared = unrefFileEventTimers.setTimeout(() => {
      fired += 10;
    }, 1);
    unrefFileEventTimers.clearTimeout(cleared);
    const every = unrefFileEventTimers.setInterval(() => {
      fired += 100;
    }, 1);
    await until(() => fired > 100, 'the interval');
    unrefFileEventTimers.clearInterval(every);
    const after = fired;
    // Timers fire in order of their due time: once this later one has, a tick the cleared interval still
    // owed would have fired before it.
    let later = false;
    unrefFileEventTimers.setTimeout(() => {
      later = true;
    }, 5);
    await until(() => later, 'a later timer to fire');

    // Assert
    should(after % 10).equal(1);
    should(fired).equal(after);
  });
});
