import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId } from '../../../../src/lib/index.ts';
import {
  composeWait,
  creditedSeconds,
  DEFAULT_COMPLETION_SUMMARY,
  InvalidDeadlineRefused,
  parkedSeconds,
  parseDeadline,
  PROTECTED_SIGNAL_STATUSES,
  signalDisplayName,
  signalStatusOf,
  waitDetail,
  type SignalTarget,
} from '../../../../src/lib/session/signal/index.ts';

/**
 * The pure decisions a signal makes.
 *
 * The deadline parser is where the dangerous cases live, so it gets most of them: an unbounded park is
 * a session that suspends its own supervision, and every path out of this function either produces a
 * bounded instant or refuses.
 */

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const BACKSTOP = 4 * 60 * 60_000;
const ID = parseSessionId('session-1');

function target(overrides: Partial<SignalTarget> = {}): SignalTarget {
  return { id: ID, status: 'running', mode: 'auto', turn: 3, ...overrides };
}

describe('the signal deadline parser', () => {
  it('should read hours, minutes and seconds, alone and combined', () => {
    // Arrange / Act / Assert
    should(parseDeadline('45m', NOW)).equal('2026-08-01T12:45:00.000Z');
    should(parseDeadline('2h', NOW)).equal('2026-08-01T14:00:00.000Z');
    should(parseDeadline('90s', NOW)).equal('2026-08-01T12:01:30.000Z');
    should(parseDeadline('1h30m', NOW)).equal('2026-08-01T13:30:00.000Z');
    // Whitespace and case are the shapes a human types, not a different request.
    should(parseDeadline('  1H 30 M 15S ', NOW)).equal('2026-08-01T13:30:15.000Z');
  });

  it('should clamp a duration beyond the backstop rather than refusing it', () => {
    // The teammate asked for something reasonable and simply gets woken earlier: a wake is a resumable
    // event, and a refusal here would leave it with no legal way to park at all.
    // Arrange / Act
    const deadline = parseDeadline('12h', NOW, BACKSTOP);

    // Assert
    should(deadline).equal(new Date(NOW + BACKSTOP).toISOString());
  });

  it('should accept an ISO timestamp in the future and clamp one past the backstop', () => {
    // Arrange / Act / Assert
    should(parseDeadline('2026-08-01T13:15:00.000Z', NOW)).equal('2026-08-01T13:15:00.000Z');
    should(parseDeadline('2026-09-01', NOW, BACKSTOP)).equal(new Date(NOW + BACKSTOP).toISOString());
  });

  it('should refuse a bare number, which Date.parse would read as a year two decades away', () => {
    // THIS IS THE CASE THE ANCHORED PATTERN EXISTS FOR. `Date.parse('45')` is the year 2045, so the
    // plausible typo `--until 45` — meaning 45 minutes — would have parked a session for twenty years
    // with no nudge, no stall kill, no ceiling and no warden verdict.
    // Arrange / Act / Assert
    should(() => parseDeadline('45', NOW)).throw(InvalidDeadlineRefused);
    should(() => parseDeadline('2026', NOW)).throw(InvalidDeadlineRefused);
  });

  it('should refuse an empty argument, a zero duration, a past instant and unreadable text', () => {
    // Arrange / Act / Assert
    should(() => parseDeadline('   ', NOW)).throw(/requires a duration/u);
    should(() => parseDeadline('0m', NOW)).throw(/positive duration/u);
    should(() => parseDeadline('2026-07-01T00:00:00.000Z', NOW)).throw(/already in the past/u);
    should(() => parseDeadline('later today', NOW)).throw(/could not read/u);
    // Date-shaped enough to pass the anchor and still not a date, so `Date.parse` answers NaN.
    should(() => parseDeadline('2026-13-45T99:99:99Z', NOW)).throw(/could not read/u);
  });

  it('should refuse a deadline exactly at the current instant', () => {
    // Equal, not merely earlier: a park whose deadline is now would be woken by the very first tick,
    // which is a wait that never happened rather than a wait that ended.
    // Arrange / Act / Assert
    should(() => parseDeadline(new Date(NOW).toISOString(), NOW)).throw(/already in the past/u);
  });
});

describe('the wait a signal composes', () => {
  it('should carry only the fields it was given', () => {
    // Arrange / Act
    const bare = composeWait('2026-08-01T12:00:00.000Z', undefined, undefined, undefined);
    const full = composeWait(
      '2026-08-01T12:00:00.000Z',
      '2026-08-01T13:00:00.000Z',
      'CI run',
      target({ teammate: 'hayden' }),
    );

    // Assert
    should(bare).deepEqual({ since: '2026-08-01T12:00:00.000Z' });
    should(full).deepEqual({
      since: '2026-08-01T12:00:00.000Z',
      until: '2026-08-01T13:00:00.000Z',
      condition: 'CI run',
      // The RESOLVED id, never the reference the caller typed.
      peer: ID,
      peerName: 'hayden',
    });
  });

  it('should record a peer with no callsign by id alone', () => {
    // Arrange / Act
    const wait = composeWait('2026-08-01T12:00:00.000Z', undefined, undefined, target());

    // Assert
    should(wait).deepEqual({ since: '2026-08-01T12:00:00.000Z', peer: ID });
  });

  it('should describe a park by its peer, its condition, or the message, in that order', () => {
    // The peer wins because it is the most specific thing a reader can act on: it names who has to
    // reply for the park to end.
    // Arrange
    const since = '2026-08-01T12:00:00.000Z';

    // Act / Assert
    should(
      waitDetail({ since, peer: 'session-2', peerName: 'hayden', until: '2026-08-01T13:00:00.000Z' }, 'note'),
    ).equal('reply from hayden — until 2026-08-01T13:00:00.000Z');
    should(waitDetail({ since, peer: 'session-2' }, 'note')).equal('reply from session-2 — open-ended');
    should(waitDetail({ since, condition: 'CI run' }, 'note')).equal('CI run — open-ended');
    should(waitDetail({ since }, 'note')).equal('note — open-ended');
    // Nothing to say about it at all still says how long it lasts.
    should(waitDetail({ since }, undefined)).equal('open-ended');
  });
});

describe('the credit a park earns back', () => {
  it('should count whole seconds from when the wait was declared', () => {
    // Arrange / Act / Assert
    should(parkedSeconds({ since: '2026-08-01T12:00:00.000Z' }, NOW + 90_400)).equal(90);
    // Never negative: a clock that moved backwards must not take credit away.
    should(parkedSeconds({ since: '2026-08-01T12:00:00.000Z' }, NOW - 5_000)).equal(0);
  });

  it('should credit nothing for a wait whose start instant will not parse', () => {
    // A credit is a concession against the turn ceiling, so an unreadable timestamp must never become
    // an arbitrarily large one.
    // Arrange / Act / Assert
    should(parkedSeconds({ since: 'not an instant' }, NOW)).equal(0);
  });

  it('should add this park to whatever the session had already banked', () => {
    // Arrange / Act
    const credited = creditedSeconds(
      target({ waitingCreditSeconds: 120 }),
      { since: '2026-08-01T12:00:00.000Z' },
      NOW + 60_000,
    );

    // Assert
    should(credited).equal(180);
  });

  it('should treat a session with no banked credit as starting from zero', () => {
    // Arrange / Act
    const credited = creditedSeconds(target(), { since: '2026-08-01T12:00:00.000Z' }, NOW + 30_000);

    // Assert
    should(credited).equal(30);
  });
});

describe('how a signal names a session to a human', () => {
  it('should prefer the callsign and fall back to the id', () => {
    // Arrange / Act / Assert
    should(signalDisplayName(target({ teammate: 'hayden' }))).equal('hayden');
    should(signalDisplayName(target())).equal(ID);
  });
});

describe('the status a signal reads off the state document', () => {
  it('should parse only statuses the protocol names and answer undefined for anything else', () => {
    // A signal retires panes and writes terminal verdicts, so a record whose status it could not read
    // must yield no target at all rather than a guessed one.
    // Arrange / Act / Assert
    should(signalStatusOf('running')).equal('running');
    should(signalStatusOf('kill_failed')).equal('kill_failed');
    should(signalStatusOf('finished')).be.undefined();
    should(signalStatusOf(undefined)).be.undefined();
    should(signalStatusOf(7)).be.undefined();
  });

  it('should protect every status another path already reached a verdict on', () => {
    // Arrange / Act / Assert
    for (const status of ['completed', 'failed', 'stalled', 'stopped', 'kill_failed'] as const)
      should(PROTECTED_SIGNAL_STATUSES.has(status)).be.true();
    // A running or parked session may still speak for itself; those are the ones the surface is for.
    for (const status of ['running', 'waiting', 'starting', 'retrying'] as const)
      should(PROTECTED_SIGNAL_STATUSES.has(status)).be.false();
  });
});

describe('the default completion summary', () => {
  it('should end in a newline, because it is a file a person opens', () => {
    // Arrange / Act / Assert
    should(DEFAULT_COMPLETION_SUMMARY.endsWith('\n')).be.true();
  });
});
