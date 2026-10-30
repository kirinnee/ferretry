import { describe, it } from 'bun:test';
import type { BigIntStats } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { BunFileEventSource } from '../../../src/adapters/file-events/bun-file-event-source.ts';
import {
  INOTIFY_MASK,
  InotifyFileEventSource,
  type InotifySyscalls,
  loadInotifySyscalls,
} from '../../../src/adapters/file-events/inotify-file-event-source.ts';
import type { StampPrimitives } from '../../../src/adapters/file-events/node-stamps.ts';
import { platformFileEventSource } from '../../../src/adapters/file-events/platform.ts';
import type { DirectoryWatchOpen } from '../../../src/lib/file-events/ports.ts';
import { waitFor } from '../support/wait-for.ts';
import { describeRealFileEvents, until, workspace } from './real-file-system.ts';

describeRealFileEvents('inotify', () => new InotifyFileEventSource(loadInotifySyscalls));

const IN_MODIFY = 0x2;
const IN_Q_OVERFLOW = 0x4000;
const IN_IGNORED = 0x8000;

/** `struct inotify_event` bytes, as the kernel writes them. */
function inotifyEvent(wd: number, mask: number, name = ''): Uint8Array {
  const padded = name.length === 0 ? 0 : Math.ceil((name.length + 1) / 16) * 16;
  const bytes = new Uint8Array(16 + padded);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, wd, true);
  view.setUint32(4, mask, true);
  view.setUint32(12, padded, true);
  bytes.set(new TextEncoder().encode(name), 16);
  return bytes;
}

/** Every call recorded; the event stream fed, ended or broken by the test. */
class FakeInotify implements InotifySyscalls {
  readonly calls: string[] = [];
  initResult = 7;
  readonly addResults: number[] = [];
  nextWd = 1;
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  init(): number {
    this.calls.push('init');
    return this.initResult;
  }

  addWatch(fd: number, path: string, mask: number): number {
    this.calls.push(`add ${String(fd)} ${path} ${String(mask === INOTIFY_MASK)}`);
    return this.addResults.shift() ?? this.nextWd++;
  }

  removeWatch(fd: number, wd: number): void {
    this.calls.push(`rm ${String(fd)} ${String(wd)}`);
  }

  close(fd: number): void {
    this.calls.push(`close ${String(fd)}`);
  }

  events(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start: controller => {
        this.controller = controller;
      },
      cancel: () => {
        this.calls.push('cancel');
      },
    });
  }

  feed(...events: Uint8Array[]): void {
    const total = events.reduce((sum, event) => sum + event.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const event of events) {
      bytes.set(event, offset);
      offset += event.byteLength;
    }
    this.controller?.enqueue(bytes);
  }
}

const directoryStats = { isDirectory: () => true, ino: 1n, birthtimeNs: 1n, size: 0n, mtimeNs: 0n };
const stamps: StampPrimitives = {
  statSync: () => directoryStats as unknown as BigIntStats,
  stat: async () => directoryStats as unknown as BigIntStats,
};

function watching(source: InotifyFileEventSource, directory: string) {
  const heard = { events: 0, errors: [] as string[] };
  const opened = source.watch(
    directory,
    () => {
      heard.events += 1;
    },
    detail => heard.errors.push(detail),
  );
  return { heard, opened, close: () => (opened.kind === 'watching' ? opened.handle.close() : undefined) };
}

describe('InotifyFileEventSource, against the kernel', () => {
  it('should hold ONE descriptor for a directory of thousands of files, and release it on close', async () => {
    // Arrange
    const directory = await workspace();
    await Promise.all(
      Array.from({ length: 500 }, async (_, index) => await writeFile(join(directory, `r-${String(index)}`), 'x')),
    );
    const before = readdirSync('/proc/self/fd').length;
    const source = new InotifyFileEventSource(loadInotifySyscalls);

    // Act
    const watch = watching(source, directory);
    await waitFor(() => readdirSync('/proc/self/fd').length > before, 'the watch to hold a descriptor');
    const during = readdirSync('/proc/self/fd').length;
    watch.close();
    await until(() => readdirSync('/proc/self/fd').length <= before, 'the descriptors to be released');

    // Assert: the instance and the duplicate Bun reads from; never one per file.
    should(watch.opened.kind).equal('watching');
    should(during - before).be.belowOrEqual(2);
  });

  it('should answer -errno from a failing call', () => {
    // Arrange
    const syscalls = loadInotifySyscalls();
    const fd = syscalls.init();

    // Act
    const wd = syscalls.addWatch(fd, '/no/such/directory', INOTIFY_MASK);
    syscalls.close(fd);

    // Assert: ENOENT.
    should(wd).equal(-2);
  });
});

describe('InotifyFileEventSource', () => {
  it('should open one instance for every watch, one watch per directory, and close it with the last', async () => {
    // Arrange
    const fake = new FakeInotify();
    const source = new InotifyFileEventSource(() => fake, stamps);

    // Act
    const a = watching(source, '/a');
    const b = watching(source, '/b');
    a.close();
    a.close();
    b.close();
    await waitFor(() => fake.calls.includes('close 7'), 'the instance to be closed with the last watch');

    // Assert
    should(fake.calls).deepEqual(['init', 'add 7 /a true', 'add 7 /b true', 'rm 7 1', 'rm 7 2', 'cancel', 'close 7']);
    should(source.reports()).be.true();
    should(source.reportsRemoval()).be.true();
  });

  it('should tell each touched directory once per read, keeping a partial event for the next read', async () => {
    // Arrange
    const fake = new FakeInotify();
    const source = new InotifyFileEventSource(() => fake, stamps);
    const a = watching(source, '/a');
    const b = watching(source, '/b');
    const event = inotifyEvent(2, IN_MODIFY, 'session.jsonl');

    // Act
    fake.feed(
      inotifyEvent(1, IN_MODIFY, 'x'),
      inotifyEvent(1, IN_MODIFY),
      inotifyEvent(99, IN_MODIFY),
      event.subarray(0, 20),
    );
    await waitFor(() => a.heard.events >= 1, 'directory /a to be told of the whole events');
    const midway = { a: a.heard.events, b: b.heard.events };
    fake.feed(event.subarray(20));
    await waitFor(() => b.heard.events >= 1, 'directory /b to be told once its partial event completed');

    // Assert
    should(midway).deepEqual({ a: 1, b: 0 });
    should(b.heard.events).equal(1);
  });

  it('should tell every directory of a queue overflow, which lost events for all of them', async () => {
    // Arrange
    const fake = new FakeInotify();
    const source = new InotifyFileEventSource(() => fake, stamps);
    const a = watching(source, '/a');
    const b = watching(source, '/b');

    // Act
    fake.feed(inotifyEvent(-1, IN_Q_OVERFLOW));
    await waitFor(() => a.heard.events >= 1 && b.heard.events >= 1, 'both directories to be told of the overflow');

    // Assert
    should([a.heard.events, b.heard.events]).deepEqual([1, 1]);
  });

  it('should forget a watch the kernel dropped, so its reused number is never removed by mistake', async () => {
    // Arrange
    const fake = new FakeInotify();
    const source = new InotifyFileEventSource(() => fake, stamps);
    const gone = watching(source, '/gone');
    const stays = watching(source, '/stays');

    // Act: the directory is deleted; the kernel drops wd 1 and later hands it to a new directory.
    fake.feed(inotifyEvent(1, IN_IGNORED));
    await waitFor(() => gone.heard.events >= 1, 'the dropped directory to be told');
    fake.nextWd = 1;
    const reused = watching(source, '/new');
    gone.close();
    fake.feed(inotifyEvent(1, IN_MODIFY));
    await waitFor(() => reused.heard.events >= 1, 'the directory that reused the number to be told');

    // Assert
    should(gone.heard.events).equal(1);
    should(fake.calls.filter(call => call.startsWith('rm'))).deepEqual([]);
    should(reused.heard.events).equal(1);
    stays.close();
  });

  it('should share one watch between two paths to the same directory', () => {
    // Arrange
    const fake = new FakeInotify();
    fake.addResults.push(1, 1);
    const source = new InotifyFileEventSource(() => fake, stamps);
    const first = watching(source, '/real');
    const second = watching(source, '/link');

    // Act
    first.close();
    const afterFirst = fake.calls.filter(call => call.startsWith('rm')).length;
    second.close();

    // Assert
    should(afterFirst).equal(0);
    should(fake.calls.filter(call => call.startsWith('rm'))).deepEqual(['rm 7 1']);
  });

  it('should tell every watch when the event stream ends or fails, and start afresh after', async () => {
    // Arrange
    const fake = new FakeInotify();
    const source = new InotifyFileEventSource(() => fake, stamps);
    const ended = watching(source, '/a');

    // Act
    fake.controller?.close();
    await waitFor(() => ended.heard.errors.length >= 1, 'the first watch to be told the stream ended');
    const failed = watching(source, '/b');
    fake.controller?.error(new Error('EBADF'));
    await waitFor(() => failed.heard.errors.length >= 1, 'the second watch to be told the stream failed');

    // Assert
    should(ended.heard.errors).deepEqual(['the inotify event stream ended']);
    should(failed.heard.errors).deepEqual(['the inotify event stream failed: EBADF']);
    should(fake.calls.filter(call => call === 'init').length).equal(2);
  });

  it('should refuse a watch for each way the kernel can say no', () => {
    // Arrange
    const refuse = (init: number, add?: number): DirectoryWatchOpen => {
      const fake = new FakeInotify();
      fake.initResult = init;
      if (add !== undefined) fake.addResults.push(add);
      return new InotifyFileEventSource(() => fake, stamps).watch(
        '/d',
        () => {},
        () => {},
      );
    };

    // Act
    const answers = [refuse(-24), refuse(-38), refuse(7, -28), refuse(7, -13), refuse(7, -2), refuse(7, -99)];

    // Assert
    should(answers).deepEqual([
      { kind: 'unavailable', reason: 'limit', detail: 'inotify_init1: EMFILE' },
      { kind: 'unavailable', reason: 'unsupported', detail: 'inotify_init1: ENOSYS' },
      {
        kind: 'unavailable',
        reason: 'limit',
        detail: 'inotify_add_watch: ENOSPC — the inotify watch limit (fs.inotify.max_user_watches) is spent',
      },
      { kind: 'unavailable', reason: 'failed', detail: 'inotify_add_watch: EACCES' },
      { kind: 'missing' },
      { kind: 'unavailable', reason: 'failed', detail: 'inotify_add_watch: errno 99' },
    ]);
  });

  it('should close the instance a refused first watch opened', () => {
    // Arrange
    const fake = new FakeInotify();
    fake.addResults.push(-28);
    const source = new InotifyFileEventSource(() => fake, stamps);

    // Act
    watching(source, '/d');

    // Assert
    should(fake.calls).deepEqual(['init', 'add 7 /d true', 'cancel', 'close 7']);
  });

  it('should not watch what is not a directory, nor stamp what cannot be stat-ed', async () => {
    // Arrange
    const fake = new FakeInotify();
    const file = { ...directoryStats, isDirectory: () => false } as unknown as BigIntStats;
    const source = new InotifyFileEventSource(() => fake, {
      statSync: () => file,
      stat: async () => await Promise.reject(new Error('ENOENT')),
    });

    // Act
    const opened = source.watch(
      '/f',
      () => {},
      () => {},
    );
    const stamped = await source.stamp('/f');

    // Assert
    should(opened).deepEqual({ kind: 'missing' });
    should(stamped).be.undefined();
    should(fake.calls).deepEqual([]);
  });
});

describe('platformFileEventSource', () => {
  it('should use inotify on Linux, fs.watch elsewhere, and refuse honestly where inotify will not load', async () => {
    // Arrange
    const broken = () => {
      throw new Error('no libc here');
    };

    // Act
    const linux = platformFileEventSource('linux');
    const darwin = platformFileEventSource('darwin');
    const unloadable = platformFileEventSource('linux', broken);
    const directory = await workspace();
    const refused = unloadable.watch(
      directory,
      () => {},
      () => {},
    );
    const onDefault = platformFileEventSource();

    // Assert
    should(linux).be.instanceOf(InotifyFileEventSource);
    should(darwin).be.instanceOf(BunFileEventSource);
    should(refused).deepEqual({
      kind: 'unavailable',
      reason: 'unsupported',
      detail: 'inotify could not be loaded: no libc here',
    });
    should(onDefault).be.instanceOf(InotifyFileEventSource);
  });
});
