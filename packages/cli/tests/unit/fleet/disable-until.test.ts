import { describe, it } from 'bun:test';
import should from 'should';
import { AccountCommandError } from '../../../src/lib/fleet/account-ports.ts';
import { parseReason, parseUntil } from '../../../src/lib/fleet/disable-until.ts';

const NOW = Date.parse('2026-10-30T12:00:00Z');

describe('parseUntil', () => {
  it('should read a bare date as the start of that day in UTC', () => {
    should(parseUntil('2026-11-01', NOW)).equal('2026-11-01T00:00:00.000Z');
  });

  it('should read a time with an offset as that instant', () => {
    should(parseUntil('2026-11-01T09:00:00+02:00', NOW)).equal('2026-11-01T07:00:00.000Z');
    should(parseUntil('2026-11-01T09:00Z', NOW)).equal('2026-11-01T09:00:00.000Z');
  });

  it('should read a wait as counted from now', () => {
    should(parseUntil('90m', NOW)).equal('2026-10-30T13:30:00.000Z');
    should(parseUntil('12h', NOW)).equal('2026-10-31T00:00:00.000Z');
    should(parseUntil('3D', NOW)).equal('2026-11-02T12:00:00.000Z');
    should(parseUntil('1w', NOW)).equal('2026-11-06T12:00:00.000Z');
  });

  it('should refuse text it cannot read, saying how to write it', () => {
    should(() => parseUntil('tomorrow', NOW)).throw(AccountCommandError, { message: /not a time I can read.*3d/ });
  });

  it('should refuse a date that does not exist', () => {
    should(() => parseUntil('2026-13-45T00:00:00Z', NOW)).throw(/not a real time/);
  });

  it('should refuse a time already passed', () => {
    should(() => parseUntil('2026-10-01', NOW)).throw(/already passed/);
    should(() => parseUntil('2026-10-30T12:00:00Z', NOW)).throw(/already passed/);
  });
});

describe('parseReason', () => {
  it('should leave an absent reason absent and trim a given one', () => {
    should(parseReason(undefined)).be.undefined();
    should(parseReason('  spend limit  ')).equal('spend limit');
  });

  it('should refuse a blank reason', () => {
    should(() => parseReason('   ')).throw(AccountCommandError, { message: /Say why/ });
  });
});
