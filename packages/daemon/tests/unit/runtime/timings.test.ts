import { describe, it } from 'bun:test';
import should from 'should';
import { DEFAULT_ACCESS_LEASE_POLICY } from '../../../src/lib/relay/link.ts';
import { DEFAULT_DAEMON_TIMINGS, describeDaemonTimings, parseDaemonTimings } from '../../../src/lib/runtime/timings.ts';

describe('parseDaemonTimings', () => {
  it('should keep the shipped numbers when nothing is set', () => {
    // Arrange / Act
    const unset = parseDaemonTimings(undefined);
    const blank = parseDaemonTimings('  ');

    // Assert
    should(unset).equal(DEFAULT_DAEMON_TIMINGS);
    should(blank).equal(DEFAULT_DAEMON_TIMINGS);
    should(DEFAULT_DAEMON_TIMINGS.lease).deepEqual({
      leaseMs: 900_000,
      renewLeadMs: 120_000,
      maxSessionMs: 43_200_000,
    });
    should(DEFAULT_DAEMON_TIMINGS.idleDayMs).equal(86_400_000);
    should(describeDaemonTimings(unset)).be.undefined();
  });

  it('should shorten each timing it names, keep the rest, and say so for the boot log', () => {
    // Arrange / Act
    const timings = parseDaemonTimings(
      '{"leaseSeconds": 6, "renewLeadSeconds": 2, "maxSessionSeconds": 20, "idleDaySeconds": 5}',
    );
    const leaseOnly = parseDaemonTimings('{"leaseSeconds": 300}');

    // Assert
    should(timings).deepEqual({
      lease: { leaseMs: 6_000, renewLeadMs: 2_000, maxSessionMs: 20_000 },
      idleDayMs: 5_000,
    });
    should(leaseOnly).deepEqual({
      lease: { ...DEFAULT_ACCESS_LEASE_POLICY, leaseMs: 300_000 },
      idleDayMs: DEFAULT_DAEMON_TIMINGS.idleDayMs,
    });
    should(describeDaemonTimings(timings)).equal(
      'FYD_TEST_TIMINGS in force: lease 6s (renewed 2s ahead), session cap 20s, one idle day 5s',
    );
  });

  it('should refuse to lengthen anything, rather than clamp it', () => {
    // A longer lease would keep a revoked device's channel open longer, so it must not boot.
    should(() => parseDaemonTimings('{"leaseSeconds": 901}')).throw(
      /^FYD_TEST_TIMINGS may only shorten the shipped timings: leaseSeconds: /u,
    );
    should(() => parseDaemonTimings('{"idleDaySeconds": 86401}')).throw(/idleDaySeconds/u);
    should(() => parseDaemonTimings('{"maxSessionSeconds": 0}')).throw(/maxSessionSeconds/u);
  });

  it('should refuse a renewal that could never be asked for, a field it does not know, and text that is not JSON', () => {
    should(() => parseDaemonTimings('{"leaseSeconds": 60}')).throw(
      /value: renewLeadSeconds must be shorter than leaseSeconds/u,
    );
    should(() => parseDaemonTimings('{"leaseMinutes": 1}')).throw(/FYD_TEST_TIMINGS may only shorten/u);
    should(() => parseDaemonTimings('lease=6')).throw('FYD_TEST_TIMINGS is not JSON: lease=6');
  });
});
