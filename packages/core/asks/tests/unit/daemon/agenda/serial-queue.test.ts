import { describe, it } from 'bun:test';
import should from 'should';
import { SerialQueue } from '../../../../daemon/lib/agenda/serial-queue.ts';

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
