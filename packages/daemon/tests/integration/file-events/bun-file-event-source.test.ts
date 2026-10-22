import { describe, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BigIntStats, FSWatcher } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import {
  BunFileEventSource,
  type FsWatchPrimitives,
  unrefFileEventTimers,
} from '../../../src/adapters/file-events/bun-file-event-source.ts';
import { describeRealFileEvents, hubOver, until, workspace } from './real-file-system.ts';

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

  it('should declare the names Bun never reports, which the hub then polls and names', async () => {
    // Arrange
    const source = new BunFileEventSource();
    const file = join(await workspace(), '~lock');
    const hub = hubOver(source);

    // Act
    const answers = ['session.jsonl', '.hidden', '~lock', ''].map(name => source.reports(name));
    const subscription = hub.subscribe(file, () => {});

    // Assert
    should(answers).deepEqual([true, false, false, false]);
    should(subscription.live()).be.false();
    should(hub.fallbacks().map(fallback => fallback.reason)).deepEqual(['unreported-name']);
  });

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
    await Bun.sleep(10);

    // Assert
    should(after % 10).equal(1);
    should(fired).equal(after);
  });
});
