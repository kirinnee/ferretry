import { describe, it } from 'bun:test';
import should from 'should';
import { type LogDescriptorWrites, OrderedLogWriter } from '../../src/adapters/runtime/ordered-log-writer.ts';

/**
 * A descriptor that records the BYTES that reached it, in order, with each asynchronous write held until the
 * test lets it go and optionally cut short, as a kernel may.
 */
function heldDisk(options: { readonly partial?: number; readonly failFirst?: boolean } = {}) {
  const landed: number[] = [];
  const held: (() => void)[] = [];
  let synchronous = 0;
  let failures = options.failFirst === true ? 1 : 0;
  const take = (bytes: Uint8Array, offset: number): number => {
    const count = Math.min(options.partial ?? Number.POSITIVE_INFINITY, bytes.byteLength - offset);
    landed.push(...bytes.subarray(offset, offset + count));
    return count;
  };
  const writes: LogDescriptorWrites = {
    writeSync: (_descriptor, bytes, offset) => {
      synchronous += 1;
      return take(bytes, offset);
    },
    write: async (_descriptor, bytes, offset) =>
      await new Promise<number>((resolve, reject) => {
        held.push(() => {
          if (failures > 0) {
            failures -= 1;
            reject(new Error('EIO'));
            return;
          }
          resolve(take(bytes, offset));
        });
      }),
  };
  const releaseOne = async (): Promise<void> => {
    held.shift()?.();
    await Bun.sleep(0);
  };
  const release = async (): Promise<void> => {
    while (held.length > 0) await releaseOne();
  };
  return {
    writes,
    text: () => new TextDecoder().decode(new Uint8Array(landed)),
    release,
    releaseOne,
    synchronous: () => synchronous,
    inFlight: () => held.length,
  };
}

describe('OrderedLogWriter', () => {
  it('should hand every line to the kernel before returning while the daemon boots', () => {
    // Arrange
    const disk = heldDisk();
    const log = new OrderedLogWriter(2, disk.writes);

    // Act
    log.write('one\n');
    log.write('two\n');

    // Assert
    should(disk.text()).equal('one\ntwo\n');
    should(disk.inFlight()).equal(0);
  });

  it('should resume a synchronous write the kernel cut short', () => {
    // Arrange
    const disk = heldDisk({ partial: 2 });
    const log = new OrderedLogWriter(2, disk.writes);

    // Act
    log.write('héllo\n');

    // Assert
    should(disk.text()).equal('héllo\n');
    should(disk.synchronous()).equal(4);
  });

  it('should return at once after boot and still deliver every line in order', async () => {
    // Arrange
    const disk = heldDisk();
    const log = new OrderedLogWriter(2, disk.writes);
    log.goAsync();

    // Act
    log.write('one\n');
    log.write('two\n');
    log.write('three\n');
    const beforeRelease = disk.text();
    await disk.release();

    // Assert
    should(beforeRelease).equal('');
    should(disk.text()).equal('one\ntwo\nthree\n');
    should(disk.synchronous()).equal(0);
  });

  it('should finish a write the kernel took only part of before starting the next', async () => {
    // Arrange
    const disk = heldDisk({ partial: 3 });
    const log = new OrderedLogWriter(2, disk.writes);
    log.goAsync();

    // Act
    log.write('héllo wörld\n');
    log.write('next\n');
    await disk.release();

    // Assert
    should(disk.text()).equal('héllo wörld\nnext\n');
  });

  it('should drop lines past its bound and say how many once the disk takes the rest', async () => {
    // Arrange
    const disk = heldDisk();
    const log = new OrderedLogWriter(2, disk.writes, 10);
    log.goAsync();
    log.write('aaaa\n');

    // Act
    log.write('bbbb\n');
    log.write('cccc\n');
    log.write('dddd\n');
    await disk.release();

    // Assert
    should(disk.text()).equal(
      'aaaa\nbbbb\ncccc\n1 log line(s) were dropped while the disk was too slow to take them\n',
    );
  });

  it('should write, at an exit that cannot wait, the unconfirmed rest of the write in flight and then the queue, in order', async () => {
    // Arrange — the first line is in flight and the kernel has taken only its first three bytes.
    const disk = heldDisk({ partial: 3 });
    const log = new OrderedLogWriter(2, disk.writes);
    log.goAsync();
    log.write('fïrst\n');
    await disk.releaseOne();
    log.write('second\n');

    // Act
    log.flushSync();
    log.write('after\n');

    // Assert — every byte once, in the order written, and the log synchronous from the flush on. (The write
    // still held is the one an exiting process never sees finish.)
    should(disk.text()).equal('fïrst\nsecond\nafter\n');
    should(log.queuedLines).equal(0);
  });

  it('should let a stopping daemon wait for everything queued, and stop waiting at its bound', async () => {
    // Arrange
    const disk = heldDisk();
    const log = new OrderedLogWriter(2, disk.writes);
    log.goAsync();
    log.write('one\n');
    log.write('two\n');

    // Act
    const bounded = log.drain(5);
    await bounded;
    const draining = log.drain(1_000);
    await disk.release();
    await draining;

    // Assert
    should(disk.text()).equal('one\ntwo\n');
    should(disk.inFlight()).equal(0);
  });

  it('should keep writing after a write the disk refused', async () => {
    // Arrange
    const disk = heldDisk({ failFirst: true });
    const log = new OrderedLogWriter(2, disk.writes);
    log.goAsync();

    // Act
    log.write('lost\n');
    await disk.release();
    log.write('kept\n');
    await disk.release();

    // Assert
    should(disk.text()).equal('kept\n');
  });
});
