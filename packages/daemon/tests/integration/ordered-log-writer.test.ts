import { describe, it } from 'bun:test';
import should from 'should';
import { type LogDescriptorWrites, OrderedLogWriter } from '../../src/adapters/runtime/ordered-log-writer.ts';

/** A descriptor that records what reached it, with each asynchronous write held until the test lets it go. */
function heldWrites(options: { readonly partial?: number; readonly failFirst?: boolean } = {}) {
  const landed: string[] = [];
  const held: (() => void)[] = [];
  let synchronous = 0;
  let failures = options.failFirst === true ? 1 : 0;
  const decoder = new TextDecoder();
  const writes: LogDescriptorWrites = {
    writeSync: (_descriptor, text) => {
      synchronous += 1;
      landed.push(text);
      return text.length;
    },
    write: async (_descriptor, bytes, offset) =>
      await new Promise<number>((resolve, reject) => {
        held.push(() => {
          if (failures > 0) {
            failures -= 1;
            reject(new Error('EIO'));
            return;
          }
          const take = Math.min(options.partial ?? Number.POSITIVE_INFINITY, bytes.byteLength - offset);
          landed.push(decoder.decode(bytes.subarray(offset, offset + take), { stream: true }));
          resolve(take);
        });
      }),
  };
  const release = async (): Promise<void> => {
    while (held.length > 0) {
      held.shift()?.();
      await Bun.sleep(0);
    }
  };
  return { writes, landed, release, synchronous: () => synchronous, inFlight: () => held.length };
}

describe('OrderedLogWriter', () => {
  it('should hand every line to the kernel before returning while the daemon boots', () => {
    // Arrange
    const disk = heldWrites();
    const log = new OrderedLogWriter(2, disk.writes);

    // Act
    log.write('one\n');
    log.write('two\n');

    // Assert
    should(disk.landed).deepEqual(['one\n', 'two\n']);
    should(disk.synchronous()).equal(2);
    should(disk.inFlight()).equal(0);
  });

  it('should return at once after boot and still deliver every line in order', async () => {
    // Arrange
    const disk = heldWrites();
    const log = new OrderedLogWriter(2, disk.writes);
    log.goAsync();

    // Act
    log.write('one\n');
    log.write('two\n');
    log.write('three\n');
    const beforeRelease = [...disk.landed];
    await disk.release();

    // Assert
    should(beforeRelease).deepEqual([]);
    should(disk.landed.join('')).equal('one\ntwo\nthree\n');
    should(disk.synchronous()).equal(0);
  });

  it('should finish a write the kernel took only part of before starting the next', async () => {
    // Arrange
    const disk = heldWrites({ partial: 3 });
    const log = new OrderedLogWriter(2, disk.writes);
    log.goAsync();

    // Act
    log.write('héllo wörld\n');
    await disk.release();
    log.write('next\n');
    await disk.release();

    // Assert
    should(disk.landed.join('')).equal('héllo wörld\nnext\n');
  });

  it('should drop lines past its bound and say how many once the disk takes the rest', async () => {
    // Arrange
    const disk = heldWrites();
    const log = new OrderedLogWriter(2, disk.writes, 10);
    log.goAsync();
    log.write('aaaa\n');

    // Act
    log.write('bbbb\n');
    log.write('cccc\n');
    log.write('dddd\n');
    await disk.release();

    // Assert
    should(disk.landed.join('')).equal(
      'aaaa\nbbbb\ncccc\n1 log line(s) were dropped while the disk was too slow to take them\n',
    );
  });

  it('should write what is still queued synchronously when the process is about to exit', () => {
    // Arrange
    const disk = heldWrites();
    const log = new OrderedLogWriter(2, disk.writes);
    log.goAsync();
    log.write('in flight\n');
    log.write('last words\n');

    // Act
    log.flushSync();

    // Assert
    should(disk.landed).deepEqual(['last words\n']);
    should(log.queuedLines).equal(0);
  });

  it('should keep writing after a write the disk refused', async () => {
    // Arrange
    const disk = heldWrites({ failFirst: true });
    const log = new OrderedLogWriter(2, disk.writes);
    log.goAsync();

    // Act
    log.write('lost\n');
    await disk.release();
    log.write('kept\n');
    await disk.release();

    // Assert
    should(disk.landed).deepEqual(['kept\n']);
  });
});
