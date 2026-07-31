import type { AccountUsage } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import { CachedUsageFeed } from '../../../src/adapters/usage/index.ts';
import type { UsageSourcePort } from '../../../src/lib/usage/index.ts';

class RecordingSource implements UsageSourcePort {
  reads = 0;
  constructor(private readonly answers: readonly (readonly AccountUsage[] | undefined | Error)[]) {}

  async read(): Promise<readonly AccountUsage[] | undefined> {
    const answer = this.answers[Math.min(this.reads, this.answers.length - 1)];
    this.reads += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

const clock = (start: number) => {
  let value = start;
  return {
    now: () => value,
    advance: (by: number) => {
      value += by;
    },
  };
};

describe('CachedUsageFeed', () => {
  it('should collect once and serve the snapshot for the whole interval', async () => {
    // Arrange
    const source = new RecordingSource([[{ agent: 'writer' }]]);
    const time = clock(1_000);
    const feed = new CachedUsageFeed([source], { now: time.now, refreshMs: 10_000 });

    // Act
    const first = await feed.accounts();
    time.advance(9_999);
    const second = await feed.accounts();

    // Assert
    should(first).deepEqual([{ agent: 'writer' }]);
    should(second).deepEqual([{ agent: 'writer' }]);
    should(source.reads).equal(1);
  });

  it('should refresh once the interval has elapsed', async () => {
    // Arrange
    const source = new RecordingSource([[{ agent: 'writer' }], [{ agent: 'reader' }]]);
    const time = clock(1_000);
    const feed = new CachedUsageFeed([source], { now: time.now, refreshMs: 10_000 });

    // Act
    await feed.accounts();
    time.advance(10_000);
    const refreshed = await feed.accounts();

    // Assert
    should(refreshed).deepEqual([{ agent: 'reader' }]);
    should(source.reads).equal(2);
  });

  it('should report no snapshot before the first successful collection', async () => {
    // Arrange
    const feed = new CachedUsageFeed([new RecordingSource([undefined])], { now: () => 1_000, refreshMs: 10_000 });

    // Act
    const accounts = await feed.accounts();

    // Assert
    should(accounts).deepEqual([]);
    should(feed.hasSnapshot()).be.false();
    should(feed.snapshotAt()).be.undefined();
  });

  it('should timestamp the snapshot so readers can say how old it is', async () => {
    // Arrange
    const feed = new CachedUsageFeed([new RecordingSource([[{ agent: 'writer' }]])], { now: () => 4_200 });

    // Act
    await feed.accounts();

    // Assert
    should(feed.hasSnapshot()).be.true();
    should(feed.snapshotAt()).equal(4_200);
  });

  it('should keep serving the last good snapshot after a failed refresh', async () => {
    // Arrange
    const source = new RecordingSource([[{ agent: 'writer' }], undefined]);
    const time = clock(1_000);
    const feed = new CachedUsageFeed([source], { now: time.now, refreshMs: 10_000 });

    // Act
    await feed.accounts();
    time.advance(10_000);
    const afterFailure = await feed.accounts();

    // Assert
    should(afterFailure).deepEqual([{ agent: 'writer' }]);
  });

  it('should back off instead of probing a failing source on every read', async () => {
    // Arrange
    const source = new RecordingSource([undefined]);
    const time = clock(1_000);
    const feed = new CachedUsageFeed([source], { now: time.now, refreshMs: 10_000 });

    // Act
    await feed.accounts();
    time.advance(5_000);
    await feed.accounts();

    // Assert
    should(source.reads).equal(1);
  });

  it('should fall back to the next source when the first cannot be read', async () => {
    // Arrange
    const primary = new RecordingSource([undefined]);
    const fallback = new RecordingSource([[{ agent: 'reader' }]]);
    const feed = new CachedUsageFeed([primary, fallback], { now: () => 1_000 });

    // Act
    const accounts = await feed.accounts();

    // Assert
    should(accounts).deepEqual([{ agent: 'reader' }]);
  });

  it('should prefer a later source that has accounts over an earlier empty one', async () => {
    // Arrange
    const primary = new RecordingSource([[]]);
    const fallback = new RecordingSource([[{ agent: 'reader' }]]);
    const feed = new CachedUsageFeed([primary, fallback], { now: () => 1_000 });

    // Act
    const accounts = await feed.accounts();

    // Assert
    should(accounts).deepEqual([{ agent: 'reader' }]);
  });

  it('should accept an empty fleet once every source agrees it is empty', async () => {
    // Arrange
    const feed = new CachedUsageFeed([new RecordingSource([[]]), new RecordingSource([undefined])], {
      now: () => 1_000,
    });

    // Act
    const accounts = await feed.accounts();

    // Assert
    should(accounts).deepEqual([]);
    should(feed.hasSnapshot()).be.true();
  });

  it('should treat a source that throws as unreadable rather than fatal', async () => {
    // Arrange
    const feed = new CachedUsageFeed(
      [new RecordingSource([new Error('boom')]), new RecordingSource([[{ agent: 'x' }]])],
      {
        now: () => 1_000,
      },
    );

    // Act
    const accounts = await feed.accounts();

    // Assert
    should(accounts).deepEqual([{ agent: 'x' }]);
  });

  it('should share one in-flight refresh across concurrent readers', async () => {
    // Arrange
    let release = (): void => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let reads = 0;
    const source: UsageSourcePort = {
      read: async () => {
        reads += 1;
        await gate;
        return [{ agent: 'writer' }];
      },
    };
    const feed = new CachedUsageFeed([source], { now: () => 1_000 });

    // Act
    const both = Promise.all([feed.accounts(), feed.accounts()]);
    release();
    const [first, second] = await both;

    // Assert
    should(reads).equal(1);
    should(first).deepEqual([{ agent: 'writer' }]);
    should(second).deepEqual([{ agent: 'writer' }]);
  });

  it('should answer an already-aborted read from cache without probing', async () => {
    // Arrange — the snapshot is stale, so only the abort can stop a second probe going out
    const source = new RecordingSource([[{ agent: 'writer' }], [{ agent: 'fresh' }]]);
    const time = clock(1_000);
    const feed = new CachedUsageFeed([source], { now: time.now, refreshMs: 10_000 });
    await feed.accounts();
    time.advance(20_000);
    const controller = new AbortController();
    controller.abort();

    // Act
    const accounts = await feed.accounts(controller.signal);

    // Assert
    should(accounts).deepEqual([{ agent: 'writer' }]);
    should(source.reads).equal(1);
  });

  it('should return the last known accounts, not an empty fleet, when a read is cancelled mid-flight', async () => {
    // Arrange — the second probe is killed by the cancellation, so the refresh comes back with nothing
    const controller = new AbortController();
    const time = clock(1_000);
    let reads = 0;
    const source: UsageSourcePort = {
      read: async signal => {
        reads += 1;
        if (reads === 1) return [{ agent: 'writer' }];
        controller.abort();
        return signal?.aborted === true ? undefined : [{ agent: 'fresh' }];
      },
    };
    const feed = new CachedUsageFeed([source], { now: time.now, refreshMs: 10_000 });
    await feed.accounts();
    time.advance(20_000);

    // Act
    const accounts = await feed.accounts(controller.signal);

    // Assert — the source answered `[]` here, indistinguishable from "every account vanished"
    should(accounts).deepEqual([{ agent: 'writer' }]);
  });

  it('should still answer a mid-flight cancellation with the reading the refresh did collect', async () => {
    // Arrange — cancelling after the data arrived must not throw that data away either
    const controller = new AbortController();
    const source: UsageSourcePort = {
      read: async () => {
        controller.abort();
        return [{ agent: 'fresh' }];
      },
    };
    const feed = new CachedUsageFeed([source], { now: () => 1_000 });

    // Act
    const accounts = await feed.accounts(controller.signal);

    // Assert
    should(accounts).deepEqual([{ agent: 'fresh' }]);
    should(feed.snapshotAt()).equal(1_000);
  });

  it('should use the wall clock and the shared interval when given no options', async () => {
    // Arrange
    const source = new RecordingSource([[{ agent: 'writer' }]]);
    const feed = new CachedUsageFeed([source]);

    // Act
    await feed.accounts();
    const again = await feed.accounts();

    // Assert
    should(again).deepEqual([{ agent: 'writer' }]);
    should(source.reads).equal(1);
    should(feed.snapshotAt()).be.a.Number();
  });
});
