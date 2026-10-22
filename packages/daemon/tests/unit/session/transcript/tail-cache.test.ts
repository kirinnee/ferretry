import { describe, it } from 'bun:test';
import should from 'should';
import { type TranscriptFingerprint, TranscriptTailCache } from '../../../../src/lib/session/transcript/tail-cache.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

const event = (id: string): TranscriptEvent => ({
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  call: { id, name: 'Bash', input: { command: 'ls' } },
});

const ids = (events: readonly TranscriptEvent[] | undefined): readonly string[] =>
  (events ?? []).map(each => (each.kind === 'tool-call' ? each.call.id : ''));

const FILE: TranscriptFingerprint = { file: '/h/big.jsonl', size: 205_000_000, mtimeMs: 1_000 };

/** A read that counts itself and answers the given events. */
const counted = (events: readonly TranscriptEvent[]) => {
  const reader = {
    reads: 0,
    read: async () => {
      reader.reads += 1;
      return events;
    },
  };
  return reader;
};

describe('TranscriptTailCache', () => {
  it('should parse an unchanged transcript once, however often it is asked for', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    const reader = counted([event('a'), event('b')]);

    // Act
    const first = await cache.events('s1', FILE, 400, reader.read);
    const again = await cache.events('s1', { ...FILE }, 400, reader.read);

    // Assert
    should(ids(first)).deepEqual(['a', 'b']);
    should(ids(again)).deepEqual(['a', 'b']);
    should(reader.reads).equal(1);
  });

  it('should parse again when the file grew, was touched or was replaced', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    const reader = counted([event('a')]);
    await cache.events('s1', FILE, 400, reader.read);

    // Act
    await cache.events('s1', { ...FILE, size: FILE.size + 10 }, 400, reader.read);
    await cache.events('s1', { ...FILE, size: FILE.size + 10, mtimeMs: 2_000 }, 400, reader.read);
    await cache.events('s1', { file: '/h/other.jsonl', size: FILE.size + 10, mtimeMs: 2_000 }, 400, reader.read);

    // Assert
    should(reader.reads).equal(4);
  });

  it('should answer a shorter ask from a longer tail, and parse again for a longer one', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    const reader = counted([event('a'), event('b'), event('c')]);
    await cache.events('s1', FILE, 3, reader.read);

    // Act
    const shorter = await cache.events('s1', FILE, 2, reader.read);
    await cache.events('s1', FILE, 10, reader.read);

    // Assert
    should(ids(shorter)).deepEqual(['b', 'c']);
    should(reader.reads).equal(2);
  });

  it('should share one parse between callers asking for the same session at once', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let reads = 0;
    const read = async () => {
      reads += 1;
      await gate;
      return [event('a'), event('b')];
    };

    // Act
    const asks = [cache.events('s1', FILE, 2, read), cache.events('s1', FILE, 1, read)];
    release();
    const [both, newest] = await Promise.all(asks);

    // Assert
    should(reads).equal(1);
    should(ids(both)).deepEqual(['a', 'b']);
    should(ids(newest)).deepEqual(['b']);
  });

  it('should not join a parse in flight that covers fewer events than asked', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return [event('a')];
    };

    // Act
    await Promise.all([cache.events('s1', FILE, 1, read), cache.events('s1', FILE, 5, read)]);

    // Assert
    should(reads).equal(2);
  });

  it('should forget nothing it could not read, so the next ask tries again', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    let reads = 0;
    const failing = async () => {
      reads += 1;
      return undefined;
    };

    // Act
    const first = await cache.events('s1', FILE, 400, failing);
    await cache.events('s1', FILE, 400, failing);

    // Assert
    should(first).be.undefined();
    should(reads).equal(2);
  });

  it('should forget the least recently asked-for session once it holds its capacity', async () => {
    // Arrange
    const cache = new TranscriptTailCache(2);
    const reader = counted([event('a')]);
    await cache.events('s1', FILE, 1, reader.read);
    await cache.events('s2', FILE, 1, reader.read);
    await cache.events('s1', FILE, 1, reader.read);

    // Act — s3 evicts s2, the least recently used, not s1.
    await cache.events('s3', FILE, 1, reader.read);
    await cache.events('s1', FILE, 1, reader.read);
    await cache.events('s2', FILE, 1, reader.read);

    // Assert
    should(reader.reads).equal(4);
  });

  it('should parse no more transcripts at once than its concurrency allows', async () => {
    // Arrange
    const cache = new TranscriptTailCache(256, 2);
    let running = 0;
    let most = 0;
    const read = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise(resolve => setImmediate(resolve));
      running -= 1;
      return [event('a')];
    };

    // Act — a cold listing of six sessions.
    const answers = await Promise.all(['s1', 's2', 's3', 's4', 's5', 's6'].map(id => cache.events(id, FILE, 1, read)));

    // Assert
    should(most).equal(2);
    should(answers.every(answer => answer?.length === 1)).be.true();
  });

  it('should release its slot when a parse throws, and not remember the failure', async () => {
    // Arrange
    const cache = new TranscriptTailCache(256, 1);
    const boom = async (): Promise<readonly TranscriptEvent[]> => {
      throw new Error('the disk went away');
    };

    // Act
    const failed = await cache.events('s1', FILE, 1, boom).catch((error: Error) => error.message);
    const next = await cache.events('s2', FILE, 1, async () => [event('b')]);

    // Assert
    should(failed).equal('the disk went away');
    should(ids(next)).deepEqual(['b']);
  });
});

/** A change feed the test drives: which paths are subscribed, and a change it fires by hand. */
class FakeFeed {
  live = true;
  readonly subscriptions: Array<{ path: string; listener: (path: string) => void; closed: boolean }> = [];

  subscribe(path: string, listener: (path: string) => void) {
    const subscription = { path, listener, closed: false };
    this.subscriptions.push(subscription);
    return {
      live: () => this.live && !subscription.closed,
      close: () => {
        subscription.closed = true;
      },
    };
  }

  change(path: string): void {
    for (const subscription of this.subscriptions)
      if (subscription.path === path && !subscription.closed) subscription.listener(path);
  }

  open(): string[] {
    return this.subscriptions.filter(subscription => !subscription.closed).map(subscription => subscription.path);
  }
}

/** A `stat` that counts itself and answers whatever the test says the file is now. */
const statted = (initial: TranscriptFingerprint | undefined = FILE) => {
  const stat = {
    calls: 0,
    current: initial as TranscriptFingerprint | undefined,
    fingerprint: async () => {
      stat.calls += 1;
      return stat.current;
    },
  };
  return stat;
};

const watchedCache = (feed: FakeFeed, clock: { now: number }, capacity = 256) =>
  new TranscriptTailCache(capacity, 2, { changes: feed, now: () => clock.now, trustMs: 10_000 });

describe('TranscriptTailCache.tail — re-validated on a file event', () => {
  it('should stat on every ask when it has no change feed, exactly as before', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    const stat = statted();
    const reader = counted([event('a')]);

    // Act
    for (let ask = 0; ask < 4; ask += 1) await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);

    // Assert
    should(stat.calls).equal(4);
    should(reader.reads).equal(1);
  });

  it('should stop stat-ing once a stat taken under a live watch matched, until the file changes', async () => {
    // Arrange
    const feed = new FakeFeed();
    const clock = { now: 0 };
    const cache = watchedCache(feed, clock);
    const stat = statted();
    const reader = counted([event('a'), event('b')]);

    // Act
    const answers = [];
    for (let ask = 0; ask < 5; ask += 1)
      answers.push(await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read));

    // Assert: the first ask parses and starts the watch, the second verifies, the rest are free.
    should(stat.calls).equal(2);
    should(reader.reads).equal(1);
    should(feed.open()).deepEqual([FILE.file]);
    should(answers.map(ids)).deepEqual(Array.from({ length: 5 }, () => ['a', 'b']));
  });

  it('should stat again after a change event, and re-parse only if the bytes differ', async () => {
    // Arrange
    const feed = new FakeFeed();
    const clock = { now: 0 };
    const cache = watchedCache(feed, clock);
    const stat = statted();
    const reader = counted([event('a')]);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);

    // Act
    feed.change(FILE.file);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);
    const afterSpurious = { stats: stat.calls, reads: reader.reads };
    feed.change(FILE.file);
    stat.current = { ...FILE, size: FILE.size + 1 };
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);

    // Assert: the stat that found new bytes was itself taken under the live watch, so it re-verifies.
    should(afterSpurious).deepEqual({ stats: 3, reads: 1 });
    should(stat.calls).equal(4);
    should(reader.reads).equal(2);
  });

  it('should not trust a stat that a change event overtook', async () => {
    // Arrange
    const feed = new FakeFeed();
    const clock = { now: 0 };
    const cache = watchedCache(feed, clock);
    const stat = statted();
    const reader = counted([event('a')]);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);

    // Act: the file changes while the verifying stat is in flight, after it read the old bytes.
    const racing = async () => {
      const answer = await stat.fingerprint();
      feed.change(FILE.file);
      return answer;
    };
    await cache.tail('s1', FILE.file, 10, racing, reader.read);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);

    // Assert: the ask after the race stat-ed again instead of trusting.
    should(stat.calls).equal(3);
  });

  it('should stat on every ask while the watch is not live', async () => {
    // Arrange
    const feed = new FakeFeed();
    feed.live = false;
    const clock = { now: 0 };
    const cache = watchedCache(feed, clock);
    const stat = statted();
    const reader = counted([event('a')]);

    // Act
    for (let ask = 0; ask < 4; ask += 1) await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);

    // Assert
    should(stat.calls).equal(4);
    should(reader.reads).equal(1);
  });

  it('should stat again once the trust bound has passed, as the backstop for a lost event', async () => {
    // Arrange
    const feed = new FakeFeed();
    const clock = { now: 0 };
    const cache = watchedCache(feed, clock);
    const stat = statted();
    const reader = counted([event('a')]);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);

    // Act
    clock.now = 9_999;
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);
    const withinBound = stat.calls;
    clock.now = 10_000;
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);

    // Assert
    should(withinBound).equal(2);
    should(stat.calls).equal(3);
  });

  it('should not answer a longer tail than it remembers without a stat', async () => {
    // Arrange
    const feed = new FakeFeed();
    const clock = { now: 0 };
    const cache = watchedCache(feed, clock);
    const stat = statted();
    const reader = counted([event('a')]);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);

    // Act
    await cache.tail('s1', FILE.file, 20, stat.fingerprint, reader.read);

    // Assert
    should(stat.calls).equal(3);
    should(reader.reads).equal(2);
  });

  it('should read uncached and watch nothing when the file cannot be stat-ed', async () => {
    // Arrange
    const feed = new FakeFeed();
    const cache = watchedCache(feed, { now: 0 });
    const stat = statted();
    stat.current = undefined;
    const reader = counted([event('a')]);

    // Act
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);
    await cache.tail('s1', FILE.file, 10, stat.fingerprint, reader.read);

    // Assert
    should(reader.reads).equal(2);
    should(feed.open()).deepEqual([]);
  });

  it('should watch nothing for a session whose read failed', async () => {
    // Arrange
    const feed = new FakeFeed();
    const cache = watchedCache(feed, { now: 0 });
    const stat = statted();

    // Act — a failed read is not remembered, so there is no tail for a watch to vouch for.
    const answer = await cache.tail('s1', FILE.file, 10, stat.fingerprint, async () => undefined);

    // Assert
    should(answer).be.undefined();
    should(feed.open()).deepEqual([]);
  });

  it('should move the watch when a session resolves to a different transcript', async () => {
    // Arrange
    const feed = new FakeFeed();
    const cache = watchedCache(feed, { now: 0 });
    const reader = counted([event('a')]);
    await cache.tail('s1', FILE.file, 10, statted().fingerprint, reader.read);
    const other: TranscriptFingerprint = { file: '/h/other.jsonl', size: 1, mtimeMs: 1 };

    // Act
    await cache.tail('s1', other.file, 10, statted(other).fingerprint, reader.read);

    // Assert
    should(feed.open()).deepEqual([other.file]);
  });

  it('should close the watch of a session it forgets, and every watch on close', async () => {
    // Arrange
    const feed = new FakeFeed();
    const cache = watchedCache(feed, { now: 0 }, 1);
    const reader = counted([event('a')]);
    const second: TranscriptFingerprint = { file: '/h/second.jsonl', size: 1, mtimeMs: 1 };
    await cache.tail('s1', FILE.file, 10, statted().fingerprint, reader.read);

    // Act
    await cache.tail('s2', second.file, 10, statted(second).fingerprint, reader.read);
    const afterEviction = feed.open();
    cache.close();

    // Assert
    should(afterEviction).deepEqual([second.file]);
    should(feed.open()).deepEqual([]);
  });
});
