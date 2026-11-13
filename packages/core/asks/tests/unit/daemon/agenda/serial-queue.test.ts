import { describe, it } from 'bun:test';
import should from 'should';
import { KeyedSerialQueue, SerialQueue } from '../../../../daemon/lib/agenda/serial-queue.ts';

describe('the serial queue', () => {
  it('should run work one at a time, in the order it was given', async () => {
    // Arrange
    const queue = new SerialQueue();
    const log: string[] = [];
    const slow = queue.run(async () => {
      log.push('slow:start');
      await new Promise(resolve => setTimeout(resolve, 10));
      log.push('slow:end');
    });

    // Act
    const fast = queue.run(async () => void log.push('fast'));
    await Promise.all([slow, fast]);

    // Assert
    should(log).eql(['slow:start', 'slow:end', 'fast']);
  });

  it('should hand back the result, and keep going after work failed', async () => {
    // Arrange
    const queue = new SerialQueue();

    // Act
    const failed = queue.run(async () => await Promise.reject(new Error('boom')));
    const next = await queue.run(async () => 7);

    // Assert
    await should(failed).be.rejectedWith('boom');
    should(next).equal(7);
  });
});

describe('the keyed serial queue', () => {
  it('should run one key in order but let another key go meanwhile', async () => {
    // Arrange
    const queue = new KeyedSerialQueue();
    const log: string[] = [];
    const slowA = queue.run('a', async () => {
      log.push('a1:start');
      await new Promise(resolve => setTimeout(resolve, 15));
      log.push('a1:end');
    });
    const nextA = queue.run('a', async () => void log.push('a2'));

    // Act
    const otherKey = queue.run('b', async () => void log.push('b1'));
    await Promise.all([slowA, nextA, otherKey]);

    // Assert
    should(log).eql(['a1:start', 'b1', 'a1:end', 'a2']);
  });

  it('should hand back the result and keep a key going after its work failed', async () => {
    // Arrange
    const queue = new KeyedSerialQueue();

    // Act
    const failed = queue.run('a', async () => await Promise.reject(new Error('boom')));
    const next = await queue.run('a', async () => 7);

    // Assert
    await should(failed).be.rejectedWith('boom');
    should(next).equal(7);
  });

  it('should make exclusive work wait for every key, and later keyed work wait for it', async () => {
    // Arrange
    const queue = new KeyedSerialQueue();
    const log: string[] = [];
    const keyed = queue.run('a', async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      log.push('a');
    });

    // Act
    const exclusive = queue.runExclusive(async () => {
      log.push('exclusive:start');
      await new Promise(resolve => setTimeout(resolve, 15));
      log.push('exclusive:end');
    });
    const after = queue.run('b', async () => void log.push('b'));
    await Promise.all([keyed, exclusive, after]);

    // Assert
    should(log).eql(['a', 'exclusive:start', 'exclusive:end', 'b']);
  });

  it('should keep going after exclusive work failed', async () => {
    // Arrange
    const queue = new KeyedSerialQueue();

    // Act
    const failed = queue.runExclusive(async () => await Promise.reject(new Error('boom')));
    const next = await queue.run('a', async () => 'ok');

    // Assert
    await should(failed).be.rejectedWith('boom');
    should(next).equal('ok');
  });
});
