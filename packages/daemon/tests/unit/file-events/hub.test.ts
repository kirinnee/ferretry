import { describe, it } from 'bun:test';
import should from 'should';
import { FILE_EVENT_POLL_MS, FILE_EVENT_SETTLE_MS, FileEventHub } from '../../../src/lib/file-events/hub.ts';
import type {
  DirectoryWatchOpen,
  DirectoryWatchUnavailable,
  FileEventSource,
  FileEventTimers,
  FileStamp,
} from '../../../src/lib/file-events/ports.ts';

let nextIno = 100n;
const stamp = (size = 0n, mtimeNs = 0n): FileStamp => {
  nextIno += 1n;
  return { ino: nextIno, birthNs: nextIno, size, mtimeNs };
};

interface Watch {
  readonly directory: string;
  readonly onEvent: () => void;
  readonly onError: (detail: string) => void;
  closed: boolean;
}

/** A file system of stamps, and a watcher whose events and failures the test fires by hand. */
class FakeSource implements FileEventSource {
  readonly entries = new Map<string, FileStamp>();
  readonly directories = new Set<string>();
  readonly watches: Watch[] = [];
  readonly refuse = new Map<string, DirectoryWatchUnavailable>();
  stats = 0;

  constructor(...directories: string[]) {
    for (const directory of directories) this.mkdir(directory);
  }

  mkdir(directory: string): void {
    this.entries.set(directory, stamp());
    this.directories.add(directory);
  }

  write(path: string, size: bigint, mtimeNs = size): void {
    const current = this.entries.get(path);
    this.entries.set(path, current === undefined ? stamp(size, mtimeNs) : { ...current, size, mtimeNs });
  }

  /** A temp file renamed over `path`: a new inode with the same size and time. */
  replace(path: string): void {
    const current = this.entries.get(path);
    this.entries.set(path, { ...stamp(current?.size, current?.mtimeNs) });
  }

  remove(path: string): void {
    this.entries.delete(path);
    this.directories.delete(path);
  }

  watch(directory: string, onEvent: () => void, onError: (detail: string) => void): DirectoryWatchOpen {
    const refused = this.refuse.get(directory);
    if (refused !== undefined) return { kind: 'unavailable', reason: refused, detail: `refused: ${refused}` };
    const identity = this.entries.get(directory);
    if (identity === undefined || !this.directories.has(directory)) return { kind: 'missing' };
    const watch: Watch = { directory, onEvent, onError, closed: false };
    this.watches.push(watch);
    return {
      kind: 'watching',
      identity,
      handle: {
        close: () => {
          watch.closed = true;
        },
      },
    };
  }

  reports(name: string): boolean {
    return !name.startsWith('.');
  }

  async stamp(path: string): Promise<FileStamp | undefined> {
    this.stats += 1;
    await Promise.resolve();
    return this.entries.get(path);
  }

  open(): string[] {
    return this.watches.filter(watch => !watch.closed).map(watch => watch.directory);
  }

  /** An event in `directory`, delivered to every watch on it — open or not, as a racing callback would be. */
  fire(directory: string, includeClosed = false): void {
    for (const watch of this.watches)
      if (watch.directory === directory && (includeClosed || !watch.closed)) watch.onEvent();
  }

  fail(directory: string, includeClosed = false): void {
    for (const watch of this.watches)
      if (watch.directory === directory && (includeClosed || !watch.closed)) watch.onError('watch died');
  }
}

/** Timers the test advances by hand. */
class FakeTimers implements FileEventTimers {
  #now = 0;
  #next = 0;
  readonly #timers = new Map<number, { at: number; every?: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    this.#next += 1;
    this.#timers.set(this.#next, { at: this.#now + ms, callback });
    return this.#next;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  setInterval(callback: () => void, ms: number): unknown {
    this.#next += 1;
    this.#timers.set(this.#next, { at: this.#now + ms, every: ms, callback });
    return this.#next;
  }

  clearInterval(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pending(): number {
    return this.#timers.size;
  }

  /** Move time on by `ms`, running every timer that comes due and letting its async work finish. */
  async advance(ms: number): Promise<void> {
    const until = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.#now = timer.at;
      if (timer.every === undefined) this.#timers.delete(id);
      else timer.at += timer.every;
      timer.callback();
      await flush();
    }
    this.#now = until;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
}

const recorder = () => {
  const heard: string[] = [];
  return { heard, listener: (path: string) => heard.push(path) };
};

const settle = async (timers: FakeTimers): Promise<void> => await timers.advance(FILE_EVENT_SETTLE_MS);

/** A hub whose subscribers have already had their unconditional first report. */
async function primed(source: FakeSource, timers: FakeTimers, hub: FileEventHub, directory: string): Promise<void> {
  source.fire(directory);
  await settle(timers);
  void hub;
}

describe('FileEventHub', () => {
  describe('one watch per directory', () => {
    it('should open one OS watch for a directory however many paths and subscribers it has', () => {
      // Arrange
      const source = new FakeSource('/', '/h', '/h/p');
      const hub = new FileEventHub(source, new FakeTimers());

      // Act
      hub.subscribe('/h/p/a.jsonl', () => {});
      hub.subscribe('/h/p/a.jsonl', () => {});
      hub.subscribe('/h/p/b.jsonl', () => {});
      hub.subscribeDirectory('/h/p', () => {});

      // Assert: the directory, and its parent for the directory's own deletion.
      should(source.open().sort()).deepEqual(['/h', '/h/p']);
    });

    it('should close the watch with its last subscriber, and its parent watch with it', () => {
      // Arrange
      const source = new FakeSource('/', '/h', '/h/p');
      const hub = new FileEventHub(source, new FakeTimers());
      const a = hub.subscribe('/h/p/a.jsonl', () => {});
      const b = hub.subscribe('/h/p/b.jsonl', () => {});
      const directory = hub.subscribeDirectory('/h/p', () => {});

      // Act
      a.close();
      a.close();
      b.close();
      const afterFiles = source.open().sort();
      directory.close();

      // Assert
      should(afterFiles).deepEqual(['/h', '/h/p']);
      should(source.open()).deepEqual([]);
    });

    it('should count the same listener subscribed twice as two subscriptions', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      const first = hub.subscribe('/h/a', listener);
      hub.subscribe('/h/a', listener);

      // Act
      first.close();
      source.write('/h/a', 5n);
      source.fire('/h');
      await settle(timers);

      // Assert
      should(heard).deepEqual(['/h/a']);
    });

    it('should not watch above the filesystem root', () => {
      // Arrange
      const source = new FakeSource('/');
      const hub = new FileEventHub(source, new FakeTimers());

      // Act
      hub.subscribe('/a.jsonl', () => {});

      // Assert
      should(source.open()).deepEqual(['/']);
    });
  });

  describe('what an event means', () => {
    it('should report a subscribed path once on the first check, before any stamp proves it unchanged', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      source.write('/h/a', 1n);
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      hub.subscribe('/h/a', listener);

      // Act
      source.fire('/h');
      await settle(timers);
      source.fire('/h');
      await settle(timers);

      // Assert
      should(heard).deepEqual(['/h/a']);
    });

    it('should re-stat EVERY subscribed path on any event, and report only those that changed', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      source.write('/h/a', 1n);
      source.write('/h/b', 1n);
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      hub.subscribe('/h/a', listener);
      hub.subscribe('/h/b', listener);
      await primed(source, timers, hub, '/h');
      heard.length = 0;

      // Act: one event, whatever it named — the platform's names are not evidence.
      source.write('/h/b', 2n);
      source.fire('/h');
      await settle(timers);

      // Assert
      should(heard).deepEqual(['/h/b']);
    });

    it('should report an atomic replace that kept size and time, by its new inode', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      source.write('/h/state.json', 9n);
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      hub.subscribe('/h/state.json', listener);
      await primed(source, timers, hub, '/h');
      heard.length = 0;

      // Act
      source.replace('/h/state.json');
      source.fire('/h');
      await settle(timers);

      // Assert
      should(heard).deepEqual(['/h/state.json']);
    });

    it('should report a file created and a file deleted', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      source.write('/h/gone', 1n);
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      hub.subscribe('/h/new', listener);
      hub.subscribe('/h/gone', listener);
      await primed(source, timers, hub, '/h');
      heard.length = 0;

      // Act
      source.write('/h/new', 1n);
      source.remove('/h/gone');
      source.fire('/h');
      await settle(timers);

      // Assert
      should(heard.sort()).deepEqual(['/h/gone', '/h/new']);
    });

    it('should coalesce a burst of events into one stat pass and one report per path', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      source.write('/h/a', 1n);
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      hub.subscribe('/h/a', listener);
      await primed(source, timers, hub, '/h');
      heard.length = 0;
      const statsBefore = source.stats;

      // Act
      for (let line = 0; line < 50; line += 1) {
        source.write('/h/a', BigInt(10 + line));
        source.fire('/h');
      }
      await settle(timers);

      // Assert: the directory and the one file, once.
      should(heard).deepEqual(['/h/a']);
      should(source.stats - statsBefore).equal(2);
    });

    it('should check again when events arrive while a check is still stat-ing', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      source.write('/h/a', 1n);
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      hub.subscribe('/h/a', listener);
      await primed(source, timers, hub, '/h');
      heard.length = 0;
      // A stat that holds the first check open until the test lets it go.
      const realStamp = source.stamp.bind(source);
      let release: () => void = () => {};
      let held = true;
      source.stamp = async path => {
        if (held) {
          held = false;
          await new Promise<void>(resolve => {
            release = resolve;
          });
        }
        return await realStamp(path);
      };

      // Act
      source.write('/h/a', 2n);
      source.fire('/h');
      await settle(timers);
      source.write('/h/a', 3n);
      source.fire('/h');
      await settle(timers);
      release();
      await flush();

      // Assert: the first pass saw the first write; the second event, landing mid-check, ran a second pass.
      should(heard).deepEqual(['/h/a', '/h/a']);
    });

    it('should tell directory subscribers of every event, and keep calling listeners after one throws', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      hub.subscribeDirectory('/h', () => {
        throw new Error('a broken listener');
      });
      hub.subscribeDirectory('/h', listener);

      // Act
      source.fire('/h');
      await settle(timers);
      await settle(timers);

      // Assert
      should(heard).deepEqual(['/h']);
    });

    it('should ignore an event from a watch it already closed', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      hub.subscribeDirectory('/h', listener).close();
      hub.subscribeDirectory('/h', listener);

      // Act: both the closed watch and the open one see the event.
      source.fire('/h', true);
      source.fail('/h', false);
      source.watches[0]?.onError('late failure from the closed watch');
      await settle(timers);

      // Assert: one report, and the closed watch's late failure did not turn the live one into a poll.
      should(heard).deepEqual(['/h']);
      should(hub.fallbacks()).deepEqual([{ directory: '/h', reason: 'failed', detail: 'watch died' }]);
    });
  });

  describe('directories that come and go', () => {
    it('should notice its directory deleted and recreated through the parent watch, and re-open', async () => {
      // Arrange
      const source = new FakeSource('/', '/h', '/h/p');
      source.write('/h/p/a', 1n);
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      const subscription = hub.subscribe('/h/p/a', listener);
      await primed(source, timers, hub, '/h/p');
      heard.length = 0;

      // Act: the directory goes, silently for its own watch, and a new one takes its place.
      source.remove('/h/p');
      source.remove('/h/p/a');
      source.mkdir('/h/p');
      source.write('/h/p/a', 7n);
      source.fire('/h');
      await settle(timers);
      await settle(timers);

      // Assert
      should(heard).deepEqual(['/h/p/a']);
      should(source.open().sort()).deepEqual(['/h', '/h/p']);
      should(source.watches.filter(watch => watch.directory === '/h/p').length).equal(2);
      should(subscription.live()).be.true();
    });

    it('should wait on the nearest existing ancestor for a directory that does not exist yet', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      const subscription = hub.subscribe('/h/a/b/t.jsonl', listener);
      const waiting = source.open();
      const liveWhileMissing = subscription.live();

      // Act: each level appears in turn.
      source.mkdir('/h/a');
      source.fire('/h');
      await settle(timers);
      await settle(timers);
      source.mkdir('/h/a/b');
      source.write('/h/a/b/t.jsonl', 3n);
      source.fire('/h/a');
      await settle(timers);
      await settle(timers);

      // Assert
      should(waiting).deepEqual(['/h']);
      should(liveWhileMissing).be.false();
      should(source.open().sort()).deepEqual(['/h/a', '/h/a/b']);
      should(heard).deepEqual(['/h/a/b/t.jsonl']);
      should(subscription.live()).be.true();
    });

    it('should go back to waiting when its directory is deleted', async () => {
      // Arrange
      const source = new FakeSource('/', '/h', '/h/p');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const subscription = hub.subscribe('/h/p/a', () => {});

      // Act
      source.remove('/h/p');
      source.fire('/h/p');
      await settle(timers);

      // Assert
      should(subscription.live()).be.false();
      should(source.open()).deepEqual(['/h']);
    });
  });

  describe('the slow-poll fallback', () => {
    it('should poll a directory at the watch limit, say so, and return to events when the limit frees', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      source.write('/h/a', 1n);
      source.refuse.set('/h', 'limit');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      const subscription = hub.subscribe('/h/a', listener);
      const fallbacks = hub.fallbacks();
      const liveWhilePolled = subscription.live();

      // Act
      await timers.advance(FILE_EVENT_POLL_MS);
      await settle(timers);
      source.refuse.delete('/h');
      await timers.advance(FILE_EVENT_POLL_MS);
      await settle(timers);

      // Assert
      should(fallbacks).deepEqual([{ directory: '/h', reason: 'limit', detail: 'refused: limit' }]);
      should(liveWhilePolled).be.false();
      should(hub.fallbacks()).deepEqual([]);
      should(subscription.live()).be.true();
      should(heard).deepEqual(['/h/a']);
    });

    it('should poll an unsupported directory by stat alone, never retrying the watch', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      source.write('/h/a', 1n);
      source.refuse.set('/h', 'unsupported');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      const directory = recorder();
      hub.subscribe('/h/a', listener);
      hub.subscribeDirectory('/h', directory.listener);
      await timers.advance(FILE_EVENT_POLL_MS);
      heard.length = 0;

      // Act
      await timers.advance(FILE_EVENT_POLL_MS);
      const quiet = [...heard];
      source.write('/h/a', 2n);
      source.write('/h', 1n);
      await timers.advance(FILE_EVENT_POLL_MS);

      // Assert
      should(quiet).deepEqual([]);
      should(heard).deepEqual(['/h/a']);
      should(directory.heard).deepEqual(['/h']);
      should(source.watches.filter(watch => watch.directory === '/h').length).equal(0);
    });

    it('should fall back to a poll when a live watch dies, and re-open it on the next poll', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      source.write('/h/a', 1n);
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      const subscription = hub.subscribe('/h/a', listener);
      await primed(source, timers, hub, '/h');
      heard.length = 0;

      // Act
      source.fail('/h');
      const fallbacks = hub.fallbacks();
      source.write('/h/a', 2n);
      await settle(timers);
      await timers.advance(FILE_EVENT_POLL_MS);
      await settle(timers);

      // Assert
      should(fallbacks).deepEqual([{ directory: '/h', reason: 'failed', detail: 'watch died' }]);
      should(heard).deepEqual(['/h/a']);
      should(hub.fallbacks()).deepEqual([]);
      should(subscription.live()).be.true();
    });

    it('should poll a name the platform never reports, and name it as a limitation', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      source.write('/h/.hidden', 1n);
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      const subscription = hub.subscribe('/h/.hidden', listener);
      await timers.advance(FILE_EVENT_POLL_MS);
      heard.length = 0;

      // Act
      source.write('/h/.hidden', 2n);
      await timers.advance(FILE_EVENT_POLL_MS);
      const fallbacks = hub.fallbacks();
      subscription.close();

      // Assert
      should(heard).deepEqual(['/h/.hidden']);
      should(subscription.live()).be.false();
      should(fallbacks).deepEqual([
        { directory: '/h', reason: 'unreported-name', detail: 'the platform watcher never reports .hidden' },
      ]);
      should(timers.pending).equal(0);
    });

    it('should stop polling a directory once its last unreported name is gone', () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      hub.subscribe('/h/a', () => {});
      const hidden = hub.subscribe('/h/.hidden', () => {});
      const polling = timers.pending;

      // Act
      hidden.close();

      // Assert
      should(polling).equal(1);
      should(timers.pending).equal(0);
    });
  });

  describe('closing', () => {
    it('should close every watch and timer, and hear nothing after', async () => {
      // Arrange
      const source = new FakeSource('/', '/h', '/k');
      source.refuse.set('/k', 'limit');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      const subscription = hub.subscribe('/h/a', listener);
      const sibling = hub.subscribe('/h/c', listener);
      hub.subscribe('/k/b', listener);
      source.fire('/h');

      // Act
      hub.close();
      await settle(timers);
      await timers.advance(FILE_EVENT_POLL_MS);
      subscription.close();
      sibling.close();

      // Assert
      should(source.open()).deepEqual([]);
      should(timers.pending).equal(0);
      should(heard).deepEqual([]);
      should(subscription.live()).be.false();
    });

    it('should drop a check whose directory was released while it was stat-ing', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      const subscription = hub.subscribe('/h/a', listener);
      source.write('/h/a', 1n);
      source.fire('/h');

      // Act: the settle runs the check, and the subscriber leaves before its stats come back.
      await timers.advance(FILE_EVENT_SETTLE_MS - 1);
      const check = timers.advance(1);
      subscription.close();
      await check;

      // Assert
      should(heard).deepEqual([]);
    });

    it('should not report a path unsubscribed while its directory was being checked', async () => {
      // Arrange
      const source = new FakeSource('/', '/h');
      const timers = new FakeTimers();
      const hub = new FileEventHub(source, timers);
      const { heard, listener } = recorder();
      hub.subscribe('/h/stays', () => {});
      const leaving = hub.subscribe('/h/a', listener);
      source.write('/h/a', 1n);
      source.fire('/h');

      // Act
      await timers.advance(FILE_EVENT_SETTLE_MS - 1);
      const check = timers.advance(1);
      leaving.close();
      await check;

      // Assert
      should(heard).deepEqual([]);
    });
  });
});
