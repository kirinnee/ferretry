import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyStallCause,
  describeDiskSaturation,
  describeIoPressure,
  HealthViewSchema,
  type IoPressure,
  IoPressureViewSchema,
  ioPressureView,
  LivenessViewSchema,
  parseIoPressure,
} from '../../src/lib/index.ts';

const BUSY_DISK = [
  'some avg10=52.10 avg60=51.30 avg300=51.00 total=123456789',
  'full avg10=46.20 avg60=45.00 avg300=44.00 total=98765432',
  '',
].join('\n');

const line = (avg10: number) => ({ avg10, avg60: avg10, avg300: avg10 });
const reading = (some: number, full?: number): IoPressure =>
  full === undefined ? { some: line(some) } : { some: line(some), full: line(full) };

describe('parseIoPressure', () => {
  it('should read both lines of a busy disk', () => {
    // Act
    const actual = parseIoPressure(BUSY_DISK);

    // Assert
    should(actual).deepEqual({
      some: { avg10: 52.1, avg60: 51.3, avg300: 51 },
      full: { avg10: 46.2, avg60: 45, avg300: 44 },
    });
  });

  it('should read a kernel that reports only some', () => {
    // Act
    const actual = parseIoPressure('some avg10=0.00 avg60=0.10 avg300=0.20 total=5\n');

    // Assert
    should(actual).deepEqual({ some: { avg10: 0, avg60: 0.1, avg300: 0.2 } });
  });

  it('should treat empty, garbled and full-only text as no reading, never throwing', () => {
    // Act / Assert
    should(parseIoPressure('')).be.undefined();
    should(parseIoPressure('not pressure at all')).be.undefined();
    should(parseIoPressure('some avg10=abc avg60=1 avg300=1')).be.undefined();
    should(parseIoPressure('some avg10=150.00 avg60=1 avg300=1')).be.undefined();
    should(parseIoPressure('full avg10=1.00 avg60=1.00 avg300=1.00 total=1')).be.undefined();
  });

  it('should ignore a full line it cannot read and keep the some line', () => {
    // Act
    const actual = parseIoPressure('some avg10=1.00 avg60=1.00 avg300=1.00 total=1\nfull avg10=1.00\n');

    // Assert
    should(actual).deepEqual({ some: line(1) });
  });
});

describe('classifyStallCause', () => {
  it('should call a disk saturated at a tenth of the time fully stalled', () => {
    // Act / Assert
    should(classifyStallCause(reading(5, 10))).equal('disk');
    should(classifyStallCause(reading(5, 9.99))).be.undefined();
  });

  it('should call a disk saturated at a quarter of the time partly stalled, with or without full', () => {
    // Act / Assert
    should(classifyStallCause(reading(25))).equal('disk');
    should(classifyStallCause(reading(24.9))).be.undefined();
    should(classifyStallCause(reading(25, 1))).equal('disk');
  });

  it('should name no cause where the host reports no pressure', () => {
    // Act / Assert
    should(classifyStallCause(undefined)).be.undefined();
  });
});

describe('io pressure wording and wire', () => {
  it('should project a reading to the wire with its verdict', () => {
    // Act / Assert
    should(ioPressureView(reading(52, 46))).deepEqual({ someAvg10: 52, fullAvg10: 46, saturated: true });
    should(ioPressureView(reading(1))).deepEqual({ someAvg10: 1, saturated: false });
  });

  it('should name the signal that crossed its bar', () => {
    // Act / Assert
    should(describeIoPressure({ someAvg10: 52, fullAvg10: 46.4 })).equal('46% full');
    should(describeIoPressure({ someAvg10: 30, fullAvg10: 2 })).equal('30% some');
    should(describeIoPressure({ someAvg10: 30 })).equal('30% some');
  });

  it('should say slow, not dead', () => {
    // Act / Assert
    should(describeDiskSaturation({ someAvg10: 52, fullAvg10: 46 })).equal(
      'disk is saturated (io pressure 46% full) — the daemon is slow, not dead',
    );
  });

  it('should accept the io block and reject a malformed one', () => {
    // Act / Assert
    should(IoPressureViewSchema.safeParse({ someAvg10: 1, saturated: false }).success).be.true();
    should(IoPressureViewSchema.safeParse({ someAvg10: 101, saturated: false }).success).be.false();
  });

  it('should keep the liveness eventLoop view valid with and without io', () => {
    // Arrange
    const base = { status: 'ok', version: '1.0.0', uptimeSeconds: 1, eventLoop: { lagMs: 0, maxLagMs: 0, stalls: 0 } };
    const withIo = { ...base, eventLoop: { ...base.eventLoop, io: { someAvg10: 40, saturated: true } } };

    // Act / Assert
    should(LivenessViewSchema.safeParse(base).success).be.true();
    should(LivenessViewSchema.safeParse(withIo).success).be.true();
  });

  it('should expose the io block on health as optional', () => {
    // Assert
    should(HealthViewSchema.shape.io.safeParse(undefined).success).be.true();
    should(HealthViewSchema.shape.io.safeParse({ someAvg10: 40, saturated: true }).success).be.true();
  });
});
