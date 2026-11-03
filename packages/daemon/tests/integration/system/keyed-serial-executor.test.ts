import { describe, it } from 'bun:test';
import should from 'should';
import { EXCLUSIVE_YIELD_LIMIT, KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('the system keyed serial executor', () => {
  it('skips observation on a busy key without blocking unrelated keys', async () => {
    const subject = new KeyedSerialExecutor();
    const hold = deferred();
    const started = deferred();
    const active = subject.run('session-1', async () => {
      started.resolve();
      await hold.promise;
      return 'active';
    });
    await started.promise;
    let skippedCalls = 0;

    const skipped = await subject.runIfIdle('session-1', async () => {
      skippedCalls += 1;
      return 'stale observation';
    });
    const other = await subject.runIfIdle('session-2', async () => 'other observation');

    should(skipped).be.undefined();
    should(skippedCalls).equal(0);
    should(other).equal('other observation');
    hold.resolve();
    should(await active).equal('active');
    should(await subject.runIfIdle('session-1', async () => 'fresh observation')).equal('fresh observation');
  });

  it('skips observation while an exclusive barrier is queued or running', async () => {
    const subject = new KeyedSerialExecutor();
    const hold = deferred();
    const started = deferred();
    const exclusive = subject.runExclusive(async () => {
      started.resolve();
      await hold.promise;
      return 'rebuilt';
    });
    await started.promise;

    should(await subject.runIfIdle('session-1', async () => 'observation')).be.undefined();

    hold.resolve();
    should(await exclusive).equal('rebuilt');
    should(await subject.runIfIdle('session-1', async () => 'observation')).equal('observation');
  });

  it('lets keyed work queued after a yielding exclusive run first, then runs it exclusively', async () => {
    // Arrange — a rebuild holds the barrier, a backlog pass queues behind it, then a session write arrives.
    const subject = new KeyedSerialExecutor();
    const order: string[] = [];
    const rebuild = deferred();
    const rebuildStarted = deferred();
    const exclusive = subject.runExclusive(async () => {
      rebuildStarted.resolve();
      await rebuild.promise;
      order.push('rebuild');
    });
    await rebuildStarted.promise;
    const pass = deferred();
    const passStarted = deferred();
    const yielding = subject.runExclusiveYielding(async () => {
      passStarted.resolve();
      order.push('pass started');
      await pass.promise;
      order.push('pass finished');
      return 'backlog';
    });
    const write = subject.run('session-1', async () => {
      order.push('write');
    });

    // Act
    rebuild.resolve();
    await write;
    await passStarted.promise;
    const late = subject.run('session-2', async () => {
      order.push('late write');
    });
    const observed = await subject.runIfIdle('session-3', async () => 'observation');
    pass.resolve();
    await late;
    await exclusive;

    // Assert — the write waited for the pass that was RUNNING, never for the one only queued; once the
    // pass ran it was exclusive, so the later write and the observation both waited or stood aside.
    should(await yielding).equal('backlog');
    should(observed).be.undefined();
    should(order).deepEqual(['rebuild', 'write', 'pass started', 'pass finished', 'late write']);
  });

  it('keeps observation running while a yielding exclusive only waits', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();
    const hold = deferred();
    const started = deferred();
    const active = subject.run('session-1', async () => {
      started.resolve();
      await hold.promise;
    });
    await started.promise;
    const yielding = subject.runExclusiveYielding(async () => 'backlog');

    // Act
    const observed = await subject.runIfIdle('session-2', async () => 'observation');
    hold.resolve();
    await active;

    // Assert — a queued backlog pass does not blank the roster's observation the way a claimed one does.
    should(observed).equal('observation');
    should(await yielding).equal('backlog');
  });

  it('stops yielding once keyed work has kept it waiting for its whole allowance', async () => {
    // Arrange — every write queues the next one before it finishes, so the keyed tails are never idle.
    const subject = new KeyedSerialExecutor();
    const order: string[] = [];
    const writes: Promise<void>[] = [];
    const total = EXCLUSIVE_YIELD_LIMIT * 4;
    const write = (index: number): void => {
      writes.push(
        subject.run(`session-${index}`, async () => {
          order.push(`write ${index}`);
          if (index + 1 < total) write(index + 1);
        }),
      );
    };
    write(0);

    // Act
    const yielding = subject.runExclusiveYielding(async () => {
      order.push('pass');
      return 'backlog';
    });
    should(await yielding).equal('backlog');
    for (let settled = 0; settled < writes.length; settled += 1) await writes[settled];

    // Assert — the pass ran in the middle of the stream instead of waiting for it to stop.
    const pass = order.indexOf('pass');
    should(pass).be.greaterThan(0);
    should(pass).be.lessThan(total);
    should(order).have.length(total + 1);
  });
});

describe('the system keyed serial executor holding several keys', () => {
  it('serializes holds whose key sets overlap, in the order they were asked for', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();
    const order: string[] = [];
    const first = deferred();
    const firstStarted = deferred();

    // Act — the second hold names one of the first's keys, in the opposite order, and must wait for it.
    const held = subject.runAcross(['a', 'b'], async () => {
      firstStarted.resolve();
      order.push('first enter');
      await first.promise;
      order.push('first exit');
    });
    await firstStarted.promise;
    const second = subject.runAcross(['c', 'a'], async () => void order.push('second'));
    await Promise.resolve();
    should(order).deepEqual(['first enter']);
    first.resolve();
    await Promise.all([held, second]);

    // Assert
    should(order).deepEqual(['first enter', 'first exit', 'second']);
  });

  it('lets holds on disjoint keys, and keyed work on other keys, run at the same time', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();
    const release = deferred();
    const started = deferred();
    const held = subject.runAcross(['a', 'b'], async () => {
      started.resolve();
      await release.promise;
      return 'held';
    });
    await started.promise;

    // Act
    const disjoint = await subject.runAcross(['c', 'd'], async () => 'disjoint');
    const keyed = await subject.run('e', async () => 'keyed');
    release.resolve();

    // Assert
    should(disjoint).equal('disjoint');
    should(keyed).equal('keyed');
    should(await held).equal('held');
  });

  it('holds each key once when a key is named twice, and runs with no keys at all', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();

    // Act
    const doubled = await subject.runAcross(['a', 'a'], async () => 'doubled');
    const none = await subject.runAcross([], async () => 'none');

    // Assert
    should(doubled).equal('doubled');
    should(none).equal('none');
    should(await subject.runIfIdle('a', async () => 'idle')).equal('idle');
  });

  it('queues keyed work behind the hold and waits for work already queued on its keys', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();
    const order: string[] = [];
    const earlier = deferred();
    const earlierStarted = deferred();
    const queued = subject.run('a', async () => {
      earlierStarted.resolve();
      await earlier.promise;
      order.push('queued before');
    });
    await earlierStarted.promise;

    // Act
    const hold = subject.runAcross(['a', 'b'], async () => void order.push('hold'));
    const after = subject.run('b', async () => void order.push('queued after'));
    earlier.resolve();
    await Promise.all([queued, hold, after]);

    // Assert
    should(order).deepEqual(['queued before', 'hold', 'queued after']);
  });

  it('waits for a running exclusive pass, and releases its keys when the work throws', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();
    const pass = deferred();
    const passStarted = deferred();
    const exclusive = subject.runExclusive(async () => {
      passStarted.resolve();
      await pass.promise;
    });
    await passStarted.promise;
    let entered = false;

    // Act
    const failed = subject
      .runAcross(['a'], async () => {
        entered = true;
        throw new Error('boom');
      })
      .catch((error: unknown) => (error as Error).message);
    await Promise.resolve();
    const enteredWhileExclusive = entered;
    pass.resolve();
    await exclusive;

    // Assert
    should(enteredWhileExclusive).be.false();
    should(await failed).equal('boom');
    should(await subject.run('a', async () => 'free')).equal('free');
    should(await subject.runIfIdle('a', async () => 'idle')).equal('idle');
  });
});
