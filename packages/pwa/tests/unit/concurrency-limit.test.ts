import { describe, it } from 'bun:test';
import should from 'should';
import { ConcurrencyLimit } from '../../src/lib/concurrency-limit.ts';

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const tick = async (): Promise<void> => {
  for (let spin = 0; spin < 5; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('a concurrency limit', () => {
  it('should run at most its limit at once and start the rest in arrival order', async () => {
    const limit = new ConcurrencyLimit(2);
    const started: number[] = [];
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const runs = gates.map((gate, index) =>
      limit.run(async () => {
        started.push(index);
        return await gate.promise;
      }),
    );
    await tick();
    should(started).deepEqual([0, 1]);
    gates[1]?.resolve(1);
    await tick();
    should(started).deepEqual([0, 1, 2]);
    // A newcomer waits behind everyone already queued, even while a slot is changing hands.
    const late = limit.run(async () => {
      started.push(9);
      return 9;
    });
    gates[0]?.resolve(0);
    gates[2]?.resolve(2);
    await tick();
    should(started).deepEqual([0, 1, 2, 3, 4]);
    gates[3]?.resolve(3);
    gates[4]?.resolve(4);
    should(await Promise.all([...runs, late])).deepEqual([0, 1, 2, 3, 4, 9]);
    should(started).deepEqual([0, 1, 2, 3, 4, 9]);
  });

  it('should free a slot when a task throws, and pass the failure to its caller', async () => {
    const limit = new ConcurrencyLimit(1);
    const failed = limit.run(async () => {
      throw new Error('boom');
    });
    const next = limit.run(async () => 'next');
    await should(failed).be.rejectedWith('boom');
    should(await next).equal('next');
    // Idle again: a task starts at once.
    should(await limit.run(async () => 'again')).equal('again');
  });

  it('should refuse a limit that could never run anything', () => {
    should(() => new ConcurrencyLimit(0)).throw(RangeError);
    should(() => new ConcurrencyLimit(1.5)).throw(RangeError);
  });
});
