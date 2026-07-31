import { describe, it } from 'bun:test';
import should from 'should';
import { KeyedSerialExecutor } from '../../../src/adapters/tasks/serial-executor.ts';

/** Yields to the event loop enough times for every queued microtask to drain. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe('KeyedSerialExecutor', () => {
  it('should run work on one key strictly one at a time', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();
    const events: string[] = [];
    const step = (name: string) => async (): Promise<string> => {
      events.push(`enter:${name}`);
      await new Promise(resolve => setTimeout(resolve, 1));
      events.push(`exit:${name}`);
      return name;
    };

    // Act
    const actual = await Promise.all([
      subject.run('board', step('a')),
      subject.run('board', step('b')),
      subject.run('board', step('c')),
    ]);

    // Assert — no interleaving, and results come back in submission order.
    should(actual).deepEqual(['a', 'b', 'c']);
    should(events).deepEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b', 'enter:c', 'exit:c']);
  });

  it('should let different keys proceed concurrently', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();
    let peak = 0;
    let active = 0;
    const step = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
    };

    // Act
    await Promise.all([subject.run('one', step), subject.run('two', step), subject.run('three', step)]);

    // Assert
    should(peak).equal(3);
  });

  it('should not let a rejected step poison later work on the same key', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();
    const order: string[] = [];

    // Act
    const failed = subject.run('board', async () => {
      order.push('failing');
      throw new Error('reducer refused');
    });
    const recovered = subject.run('board', async () => {
      order.push('recovered');
      return 'ok';
    });

    // Assert
    await should(failed).be.rejectedWith('reducer refused');
    should(await recovered).equal('ok');
    should(order).deepEqual(['failing', 'recovered']);
  });

  it('should keep serialising after a rejection rather than running the queue in parallel', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();
    let active = 0;
    let peak = 0;
    const slow = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
    };

    // Act
    const results = await Promise.allSettled([
      subject.run('board', async () => {
        await slow();
        throw new Error('boom');
      }),
      subject.run('board', slow),
      subject.run('board', slow),
    ]);

    // Assert
    should(peak).equal(1);
    should(results.map(result => result.status)).deepEqual(['rejected', 'fulfilled', 'fulfilled']);
  });

  it('should release a key once its queue drains, including after a failure', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();

    // Act
    await subject.run('kept', async () => 'ok');
    await settle();
    const afterSuccess = subject.pendingKeys();
    await subject
      .run('kept', async () => {
        throw new Error('boom');
      })
      .catch(() => undefined);
    await settle();
    const afterFailure = subject.pendingKeys();

    // Assert — no per-key leak in a daemon that touches many boards over its lifetime.
    should(afterSuccess).equal(0);
    should(afterFailure).equal(0);
  });

  it('should hold the key while work is still queued', async () => {
    // Arrange
    const subject = new KeyedSerialExecutor();
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    // Act
    const running = subject.run('board', async () => await gate);
    const queued = subject.run('board', async () => 'second');
    const whileBusy = subject.pendingKeys();
    release();
    await Promise.all([running, queued]);
    await settle();

    // Assert
    should(whileBusy).equal(1);
    should(subject.pendingKeys()).equal(0);
  });
});
