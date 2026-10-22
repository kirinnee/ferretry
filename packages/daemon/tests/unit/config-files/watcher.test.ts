import { describe, it } from 'bun:test';
import should from 'should';
import {
  CONFIG_WATCH_BACKSTOP_MS,
  CONFIG_WATCH_DEBOUNCE_MS,
  CONFIG_WATCH_INTERVAL_MS,
  type ConfigTreeEvents,
  type ConfigWatchTimers,
  watchConfigFiles,
} from '../../../src/lib/config-files/index.ts';

/** Timers a test fires by hand. */
class FakeTimers implements ConfigWatchTimers {
  #next = 0;
  readonly intervals = new Map<number, { callback: () => void; ms: number }>();
  readonly timeouts = new Map<number, { callback: () => void; ms: number }>();

  setInterval(callback: () => void, ms: number): unknown {
    this.#next += 1;
    this.intervals.set(this.#next, { callback, ms });
    return this.#next;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }
  setTimeout(callback: () => void, ms: number): unknown {
    this.#next += 1;
    this.timeouts.set(this.#next, { callback, ms });
    return this.#next;
  }
  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  /** One interval tick. */
  tick(): void {
    for (const { callback } of this.intervals.values()) callback();
  }
  /** Fire every pending timeout, as if the debounce elapsed. */
  settle(): void {
    const due = [...this.timeouts.entries()];
    for (const [handle, { callback }] of due) {
      this.timeouts.delete(handle);
      callback();
    }
  }
}

const flush = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
};

const watch = (fingerprints: () => Promise<string>, onChange: () => Promise<void> = async () => undefined) => {
  const timers = new FakeTimers();
  const errors: unknown[] = [];
  let changes = 0;
  const stop = watchConfigFiles({
    fingerprint: fingerprints,
    onChange: async () => {
      changes += 1;
      await onChange();
    },
    onError: error => errors.push(error),
    timers,
  });
  return { timers, errors, stop, changes: () => changes };
};

describe('watchConfigFiles', () => {
  it('should say the tree may have changed as soon as a polled fingerprint moves', async () => {
    // Arrange
    let fingerprint = 'a';
    const timers = new FakeTimers();
    let told = 0;
    watchConfigFiles({
      fingerprint: async () => fingerprint,
      onEvent: () => {
        told += 1;
      },
      onChange: async () => undefined,
      onError: () => undefined,
      timers,
    });
    await flush();

    // Act
    timers.tick();
    await flush();
    fingerprint = 'b';
    timers.tick();
    await flush();

    // Assert — the baseline and an unchanged tick say nothing; the move says so before any settle.
    should(told).equal(1);
    should(timers.timeouts.size).equal(1);
  });

  it('should poll on the shipped interval and treat the first fingerprint as the baseline', async () => {
    // Arrange
    const { timers, changes } = watch(async () => 'a');

    // Act
    await flush();
    timers.tick();
    await flush();
    timers.settle();

    // Assert
    should([...timers.intervals.values()].map(interval => interval.ms)).eql([CONFIG_WATCH_INTERVAL_MS]);
    should(timers.timeouts.size).equal(0);
    should(changes()).equal(0);
  });

  it('should fire onChange once, after the debounce, when the fingerprint moves', async () => {
    // Arrange
    let fingerprint = 'a';
    const { timers, changes } = watch(async () => fingerprint);
    await flush();

    // Act
    fingerprint = 'b';
    timers.tick();
    await flush();
    const beforeSettle = changes();
    const debounce = [...timers.timeouts.values()].map(timeout => timeout.ms);
    timers.settle();
    await flush();
    timers.tick();
    await flush();
    timers.settle();

    // Assert
    should(beforeSettle).equal(0);
    should(debounce).eql([CONFIG_WATCH_DEBOUNCE_MS]);
    should(changes()).equal(1);
  });

  it('should fire once for two changes inside one debounce', async () => {
    // Arrange
    let fingerprint = 'a';
    const { timers, changes } = watch(async () => fingerprint);
    await flush();

    // Act
    fingerprint = 'b';
    timers.tick();
    await flush();
    fingerprint = 'c';
    timers.tick();
    await flush();
    const armed = timers.timeouts.size;
    timers.settle();
    await flush();

    // Assert
    should(armed).equal(1);
    should(changes()).equal(1);
  });

  it('should report a failed fingerprint and a failed load, and keep polling', async () => {
    // Arrange
    let fingerprint: string | Error = 'a';
    const { timers, errors, changes } = watch(
      async () => {
        if (fingerprint instanceof Error) throw fingerprint;
        return fingerprint;
      },
      async () => {
        throw new Error('load failed');
      },
    );
    await flush();

    // Act
    fingerprint = new Error('stat failed');
    timers.tick();
    await flush();
    fingerprint = 'b';
    timers.tick();
    await flush();
    timers.settle();
    await flush();

    // Assert
    should(errors.map(error => (error as Error).message)).eql(['stat failed', 'load failed']);
    should(changes()).equal(1);
    should(timers.intervals.size).equal(1);
  });

  it('should clear its timers on stop and never fire a settle that was pending', async () => {
    // Arrange
    let fingerprint = 'a';
    const { timers, stop, changes } = watch(async () => fingerprint);
    await flush();
    fingerprint = 'b';
    timers.tick();
    await flush();
    const pending = [...timers.timeouts.values()];

    // Act
    stop();
    for (const timeout of pending) timeout.callback();
    await flush();

    // Assert
    should(timers.intervals.size).equal(0);
    should(timers.timeouts.size).equal(0);
    should(changes()).equal(0);
  });

  it('should stop without a pending settle', async () => {
    // Arrange
    const { timers, stop } = watch(async () => 'a');
    await flush();

    // Act
    stop();

    // Assert
    should(timers.intervals.size).equal(0);
  });

  it('should not arm a settle for a change seen after stop', async () => {
    // Arrange
    let fingerprint = 'a';
    let release: (() => void) | undefined;
    const { timers, stop } = watch(async () => {
      if (fingerprint === 'b') await new Promise<void>(resolve => (release = resolve));
      return fingerprint;
    });
    await flush();
    fingerprint = 'b';
    const tick = [...timers.intervals.values()][0];
    tick?.callback();
    await flush();

    // Act
    stop();
    release?.();
    await flush();

    // Assert
    should(timers.timeouts.size).equal(0);
  });

  it('should skip a poll while the previous one is still reading', async () => {
    // Arrange
    let calls = 0;
    let release: (() => void) | undefined;
    const { timers } = watch(async () => {
      calls += 1;
      if (calls === 2) await new Promise<void>(resolve => (release = resolve));
      return 'a';
    });
    await flush();

    // Act
    timers.tick();
    await flush();
    timers.tick();
    timers.tick();
    await flush();
    const whileBusy = calls;
    release?.();
    await flush();
    timers.tick();
    await flush();

    // Assert
    should(whileBusy).equal(2);
    should(calls).equal(3);
  });
});

/** A tree the test reshapes, whose directories' events the test fires. */
class FakeTree implements ConfigTreeEvents {
  directoriesNow: readonly string[] = ['/config'];
  failure: Error | undefined;
  readonly listeners = new Map<string, () => void>();
  readonly closed: string[] = [];

  async directories(): Promise<readonly string[]> {
    if (this.failure !== undefined) throw this.failure;
    return this.directoriesNow;
  }

  subscribeDirectory(path: string, listener: () => void): { close(): void } {
    this.listeners.set(path, listener);
    return {
      close: () => {
        this.listeners.delete(path);
        this.closed.push(path);
      },
    };
  }

  fire(path: string): void {
    this.listeners.get(path)?.();
  }
}

const watchEvents = (tree: FakeTree, fingerprints: () => Promise<string>) => {
  const timers = new FakeTimers();
  const errors: unknown[] = [];
  let changes = 0;
  let reads = 0;
  const stop = watchConfigFiles({
    fingerprint: async () => {
      reads += 1;
      return await fingerprints();
    },
    onChange: async () => {
      changes += 1;
    },
    onError: error => errors.push(error),
    timers,
    events: tree,
  });
  return { timers, errors, stop, changes: () => changes, reads: () => reads };
};

describe('watchConfigFiles, driven by file events', () => {
  it('should read on the slow backstop, not every second, and watch every directory of the tree', async () => {
    // Arrange
    const tree = new FakeTree();
    tree.directoriesNow = ['/config', '/config/logins'];

    // Act
    const { timers, reads } = watchEvents(tree, async () => 'a');
    await flush();

    // Assert
    should([...timers.intervals.values()].map(interval => interval.ms)).eql([CONFIG_WATCH_BACKSTOP_MS]);
    should([...tree.listeners.keys()]).eql(['/config', '/config/logins']);
    should(reads()).equal(1);
  });

  it('should read on an event, load after the debounce, and watch a directory that appeared', async () => {
    // Arrange
    let fingerprint = 'a';
    const tree = new FakeTree();
    const { timers, changes } = watchEvents(tree, async () => fingerprint);
    await flush();

    // Act: components/mcp/ is created with a file in it; the root hears it.
    tree.directoriesNow = ['/config', '/config/components', '/config/components/mcp'];
    fingerprint = 'b';
    tree.fire('/config');
    await flush();
    timers.settle();
    await flush();

    // Assert
    should(changes()).equal(1);
    should([...tree.listeners.keys()]).eql(['/config', '/config/components', '/config/components/mcp']);
  });

  it('should say the tree may have changed the moment an event arrives, before the debounce', async () => {
    // Arrange
    const tree = new FakeTree();
    const timers = new FakeTimers();
    let told = 0;
    let changes = 0;
    watchConfigFiles({
      fingerprint: async () => 'a',
      onEvent: () => {
        told += 1;
      },
      onChange: async () => {
        changes += 1;
      },
      onError: () => undefined,
      timers,
      events: tree,
    });
    await flush();

    // Act — the fingerprint has not moved, so nothing loads; readers are still told not to trust it.
    tree.fire('/config');

    // Assert
    should(told).equal(1);
    should(changes).equal(0);
  });

  it('should stop watching a directory that is gone', async () => {
    // Arrange
    const tree = new FakeTree();
    tree.directoriesNow = ['/config', '/config/logins'];
    watchEvents(tree, async () => 'a');
    await flush();

    // Act
    tree.directoriesNow = ['/config'];
    tree.fire('/config');
    await flush();

    // Assert
    should(tree.closed).eql(['/config/logins']);
    should([...tree.listeners.keys()]).eql(['/config']);
  });

  it('should read once more for an event that arrived during a read, but not for a backstop tick', async () => {
    // Arrange
    let release: (() => void) | undefined;
    let hold = false;
    const tree = new FakeTree();
    const { timers, reads } = watchEvents(tree, async () => {
      if (hold) {
        hold = false;
        await new Promise<void>(resolve => (release = resolve));
      }
      return 'a';
    });
    await flush();

    // Act
    hold = true;
    tree.fire('/config');
    await flush();
    tree.fire('/config');
    timers.tick();
    await flush();
    const whileBusy = reads();
    release?.();
    await flush();

    // Assert
    should(whileBusy).equal(2);
    should(reads()).equal(3);
  });

  it('should report a tree it cannot list, and close every watch on stop', async () => {
    // Arrange
    const tree = new FakeTree();
    const { errors, stop } = watchEvents(tree, async () => 'a');
    await flush();

    // Act
    tree.failure = new Error('config directory unreadable');
    tree.fire('/config');
    await flush();
    stop();

    // Assert
    should(errors.map(error => (error as Error).message)).eql(['config directory unreadable']);
    should(tree.closed).eql(['/config']);
    should(tree.listeners.size).equal(0);
  });

  it('should watch nothing new when stopped while the tree was being listed', async () => {
    // Arrange
    let release: (() => void) | undefined;
    const tree = new FakeTree();
    const listed = tree.directories.bind(tree);
    tree.directories = async () => {
      await new Promise<void>(resolve => (release = resolve));
      return await listed();
    };
    const { stop } = watchEvents(tree, async () => 'a');
    await flush();

    // Act
    stop();
    release?.();
    await flush();

    // Assert
    should(tree.listeners.size).equal(0);
  });
});
