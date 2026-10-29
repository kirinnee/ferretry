import { describe, it } from 'bun:test';
import should from 'should';
import {
  deliverableLength,
  leadingContinuationBytes,
  PARTIAL_LINE_HOLD_MAX,
  readWindow,
} from '../../../../src/lib/session/processes/output.ts';

/**
 * BOUNDED, FOLLOWABLE READS OF AN OUTPUT FILE — and the rule that a live read delivers whole lines only,
 * because a secret written across two reads would be masked in neither.
 */

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('readWindow', () => {
  it('should read the whole of a file smaller than one read when asked from the start', () => {
    // Arrange / Act
    const window = readWindow(50, undefined, 100);

    // Assert
    should(window).deepEqual({ from: 0, to: 50, skipped: false, reset: false });
  });

  it('should read only the tail of a larger file on the first read, and say bytes were skipped', () => {
    // Arrange / Act
    const window = readWindow(1_000, undefined, 100);

    // Assert
    should(window).deepEqual({ from: 900, to: 1_000, skipped: true, reset: false });
  });

  it('should follow: read what was written after the previous read’s end', () => {
    // Arrange / Act
    const window = readWindow(600, 500, 100);

    // Assert
    should(window).deepEqual({ from: 500, to: 600, skipped: false, reset: false });
  });

  it('should return nothing new when the reader is exactly at the end', () => {
    // Arrange / Act
    const window = readWindow(600, 600, 100);

    // Assert
    should(window).deepEqual({ from: 600, to: 600, skipped: false, reset: false });
  });

  it('should treat a gap of exactly one read as no gap, and one byte more as a skip to the tail', () => {
    // Arrange / Act
    const exact = readWindow(200, 100, 100);
    const over = readWindow(201, 100, 100);

    // Assert
    should(exact).deepEqual({ from: 100, to: 200, skipped: false, reset: false });
    should(over).deepEqual({ from: 101, to: 201, skipped: true, reset: false });
  });

  it('should skip a gap larger than one read, landing on the tail', () => {
    // Arrange / Act
    const window = readWindow(1_000, 100, 100);

    // Assert
    should(window).deepEqual({ from: 900, to: 1_000, skipped: true, reset: false });
  });

  it('should reset when the file is shorter than where the reader was, restarting from the tail', () => {
    // Arrange / Act
    const small = readWindow(40, 500, 100);
    const large = readWindow(1_000, 5_000, 100);

    // Assert
    should(small).deepEqual({ from: 0, to: 40, skipped: false, reset: true });
    should(large).deepEqual({ from: 900, to: 1_000, skipped: true, reset: true });
  });

  it('should read an empty file as an empty window', () => {
    // Arrange / Act
    const window = readWindow(0, undefined, 100);

    // Assert
    should(window).deepEqual({ from: 0, to: 0, skipped: false, reset: false });
  });
});

describe('deliverableLength', () => {
  it('should hold back a partial last line while the process runs', () => {
    // Arrange
    const read = bytes('first\nsecond\nthi');

    // Act
    const length = deliverableLength(read, false);

    // Assert
    should(length).equal(13);
  });

  it('should deliver everything when the read ends on a line ending', () => {
    // Arrange
    const read = bytes('first\nsecond\n');

    // Act
    const length = deliverableLength(read, false);

    // Assert
    should(length).equal(read.byteLength);
  });

  it('should treat a carriage return as a line end, as a progress bar redraws with it', () => {
    // Arrange
    const read = bytes('10%\r20%\r30');

    // Act
    const length = deliverableLength(read, false);

    // Assert
    should(length).equal(8);
  });

  it('should deliver nothing yet for a single unfinished line', () => {
    // Arrange / Act
    const length = deliverableLength(bytes('no newline yet'), false);

    // Assert
    should(length).equal(0);
  });

  it('should deliver the fragment as it is once the process has exited', () => {
    // Arrange
    const read = bytes('last line, no newline');

    // Act
    const length = deliverableLength(read, true);

    // Assert
    should(length).equal(read.byteLength);
  });

  it('should deliver a fragment longer than the hold limit, and hold one exactly at it', () => {
    // Arrange
    const atLimit = new Uint8Array(PARTIAL_LINE_HOLD_MAX).fill(0x61);
    const overLimit = new Uint8Array(PARTIAL_LINE_HOLD_MAX + 1).fill(0x61);

    // Act / Assert
    should(deliverableLength(atLimit, false)).equal(0);
    should(deliverableLength(overLimit, false)).equal(PARTIAL_LINE_HOLD_MAX + 1);
  });

  it('should still cut at the last line ending of a long read that ends in a fragment', () => {
    // Arrange
    const read = bytes(`line\n${'a'.repeat(PARTIAL_LINE_HOLD_MAX + 10)}`);

    // Act
    const length = deliverableLength(read, false);

    // Assert
    should(length).equal(5);
  });

  it('should deliver an empty read as empty', () => {
    // Arrange / Act / Assert
    should(deliverableLength(new Uint8Array(), false)).equal(0);
    should(deliverableLength(new Uint8Array(), true)).equal(0);
  });
});

describe('leadingContinuationBytes', () => {
  it('should drop nothing from a read that began at the start of the file', () => {
    // Arrange
    const read = new Uint8Array([0x80, 0x80, 0x41]);

    // Act
    const dropped = leadingContinuationBytes(read, false);

    // Assert
    should(dropped).equal(0);
  });

  it('should drop the continuation bytes a mid-file read starts inside', () => {
    // Arrange — the tail of `é` (0xC3 0xA9) and of a three-byte character, then ASCII.
    const one = new Uint8Array([0xa9, 0x41]);
    const two = new Uint8Array([0x80, 0xa9, 0x41]);

    // Act / Assert
    should(leadingContinuationBytes(one, true)).equal(1);
    should(leadingContinuationBytes(two, true)).equal(2);
  });

  it('should drop at most three, and none when the first byte starts a character', () => {
    // Arrange
    const many = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80]);
    const whole = new Uint8Array([0xc3, 0xa9]);

    // Act / Assert
    should(leadingContinuationBytes(many, true)).equal(3);
    should(leadingContinuationBytes(whole, true)).equal(0);
    should(leadingContinuationBytes(new Uint8Array(), true)).equal(0);
  });
});
