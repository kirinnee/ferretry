import { describe, it } from 'bun:test';
import should from 'should';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';

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
});
