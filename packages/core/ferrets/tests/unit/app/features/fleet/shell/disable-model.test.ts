import { describe, expect, it } from 'bun:test';
import {
  disableChange,
  disabledDetail,
  enableChange,
  OFF_HELPER,
  offHeadline,
  REASON_LIMIT,
  reasonProblem,
  switchOwner,
  untilFor,
  untilWords,
} from '../../../../../src/features/fleet/shell/disable-model.ts';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const LOGIN = { kind: 'login', id: 'liftoff' } as const;
const RUNTIME = { kind: 'runtime', name: 'liftoff-agent' } as const;

describe('untilFor', () => {
  it('should end at nothing for "until I turn it on"', () => {
    expect(untilFor('forever', '', NOW)).toEqual({ kind: 'ok' });
  });

  it('should count a day and a week from now', () => {
    expect(untilFor('day', '', NOW)).toEqual({ kind: 'ok', until: '2026-10-31T12:00:00.000Z' });
    expect(untilFor('week', '', NOW)).toEqual({ kind: 'ok', until: '2026-11-06T12:00:00.000Z' });
  });

  it('should read a date as the start of that day in UTC', () => {
    expect(untilFor('date', '2026-11-01', NOW)).toEqual({ kind: 'ok', until: '2026-11-01T00:00:00.000Z' });
  });

  it('should refuse a date that is missing, not real, or not after now', () => {
    expect(untilFor('date', '', NOW)).toEqual({ kind: 'problem', message: 'Pick the day it comes back.' });
    expect(untilFor('date', '2026-13-45', NOW)).toEqual({ kind: 'problem', message: 'That is not a real day.' });
    expect(untilFor('date', '2026-10-30', NOW)).toEqual({ kind: 'problem', message: 'Pick a day after today.' });
  });
});

describe('reasonProblem', () => {
  it('should accept none, and a reason up to the limit, and refuse a longer one', () => {
    expect(reasonProblem('')).toBeNull();
    expect(reasonProblem('x'.repeat(REASON_LIMIT))).toBeNull();
    expect(reasonProblem('x'.repeat(REASON_LIMIT + 1))).toMatch(/under 200/);
  });
});

describe('the changes', () => {
  it('should switch a login off with a trimmed reason and an end', () => {
    expect(disableChange(LOGIN, '  spend limit ', '2026-11-01T00:00:00.000Z')).toEqual({
      kind: 'credential.disable',
      id: 'liftoff',
      reason: 'spend limit',
      until: '2026-11-01T00:00:00.000Z',
    });
  });

  it('should leave out a blank reason and no end', () => {
    expect(disableChange(RUNTIME, '   ', undefined)).toEqual({ kind: 'runtime.disable', name: 'liftoff-agent' });
  });

  it('should switch either back on', () => {
    expect(enableChange(LOGIN)).toEqual({ kind: 'credential.enable', id: 'liftoff' });
    expect(enableChange(RUNTIME)).toEqual({ kind: 'runtime.enable', name: 'liftoff-agent' });
  });
});

describe('untilWords', () => {
  it('should show a start-of-day as a date and any other time with its UTC time', () => {
    expect(untilWords('2026-11-01T00:00:00.000Z')).toBe('1 Nov 2026');
    expect(untilWords('2026-11-01T09:05:00.000Z')).toBe('1 Nov 2026, 09:05 UTC');
  });

  it('should hand back text it cannot read', () => {
    expect(untilWords('soon')).toBe('soon');
  });
});

describe('what an off switch says', () => {
  it('should give the reason and when it comes back', () => {
    expect(disabledDetail({ reason: 'Spend limit reached', until: '2026-11-01T00:00:00.000Z', source: 'login' })).toBe(
      'Spend limit reached. Back on 1 Nov 2026.',
    );
  });

  it('should not double a full stop, and should say when there is no end', () => {
    expect(disabledDetail({ reason: 'Over budget.', source: 'login' })).toBe(
      'Over budget. Stays off until you turn it on.',
    );
  });

  it('should say only the end when there is no reason', () => {
    expect(disabledDetail({ until: '2026-11-01T09:00:00.000Z', source: 'runtime' })).toBe(
      'Back on 1 Nov 2026, 09:00 UTC.',
    );
    expect(disabledDetail({ source: 'runtime' })).toBe('Stays off until you turn it on.');
  });
});

describe('whose block it is', () => {
  it('should hand a runtime held off by its login to the login', () => {
    expect(switchOwner(RUNTIME, { source: 'login' })).toBe('login');
    expect(offHeadline(RUNTIME, { source: 'login' }, 'liftoff')).toBe('Off because its login liftoff is disabled');
  });

  it('should keep its own block, and a login’s, with the switch in front of you', () => {
    expect(switchOwner(RUNTIME, { source: 'runtime' })).toBe('own');
    expect(switchOwner(LOGIN, { source: 'login' })).toBe('own');
    expect(offHeadline(LOGIN, { source: 'login' }, '')).toBe(OFF_HELPER);
  });
});
