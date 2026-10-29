import { describe, it } from 'bun:test';
import should from 'should';
import { memoryUsage } from '../../../src/adapters/runtime/memory-usage.ts';

const reading: NodeJS.MemoryUsage = { rss: 4, heapTotal: 3, heapUsed: 2, external: 1, arrayBuffers: 0 };

/** Bun's own error for an interrupted read: a `SystemError` naming the syscall and the errno it held. */
const interrupted = (): Error =>
  Object.assign(new Error('Failed to get memory usage'), { errno: 4, syscall: 'memoryUsage' });

/** A reader that throws each of `failures` in turn, then answers. */
function readerFailing(...failures: Error[]): { read: () => NodeJS.MemoryUsage; calls: () => number } {
  let calls = 0;
  return {
    read: () => {
      const failure = failures[calls++];
      if (failure !== undefined) throw failure;
      return reading;
    },
    calls: () => calls,
  };
}

describe('memoryUsage', () => {
  it('should read this real process', () => {
    // Act
    const actual = memoryUsage();

    // Assert
    should(actual.rss).be.above(0);
    should(actual.heapTotal).be.above(0);
  });

  it('should ask again when the read was interrupted, by errno or by code', () => {
    // Arrange
    const reader = readerFailing(interrupted(), Object.assign(new Error('interrupted'), { code: 'EINTR' }));

    // Act
    const actual = memoryUsage(reader.read);

    // Assert
    should(actual).equal(reading);
    should(reader.calls()).equal(3);
  });

  it('should give up with the interruption once every attempt was interrupted', () => {
    // Arrange
    const reader = readerFailing(interrupted(), interrupted(), interrupted());

    // Act / Assert
    should(() => memoryUsage(reader.read, 2)).throw({ errno: 4 });
    should(reader.calls()).equal(2);
  });

  it('should let every other failure through at once', () => {
    // Arrange
    const reader = readerFailing(Object.assign(new Error('Failed to get memory usage'), { errno: 22 }));
    const thrown = readerFailing(Object.assign(new Error('odd'), { errno: -4 }));
    const bare = (): NodeJS.MemoryUsage => {
      throw 'not an error';
    };

    // Act / Assert
    should(() => memoryUsage(reader.read)).throw({ errno: 22 });
    should(reader.calls()).equal(1);
    should(memoryUsage(thrown.read)).equal(reading);
    should(() => memoryUsage(bare)).throw();
  });
});
