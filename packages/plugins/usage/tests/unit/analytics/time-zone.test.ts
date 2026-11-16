import { describe, it } from 'bun:test';
import { AnalyticsQueryError, type AnalyticsIndexStatus, type AnalyticsRawSession } from '../../../contract/index.ts';
import should from 'should';
import { queryAnalyticsRecords } from '../../../daemon/lib/analytics/results.ts';
import { isTimeZone, zonedDay, zonedMidnight, zonedWeek } from '../../../daemon/lib/analytics/time-zone.ts';

const index: AnalyticsIndexStatus = {
  schemaVersion: 1,
  sessions: 3,
  tokenSessions: 3,
  transcriptSources: 0,
  indexedTranscriptSources: 0,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};

/** One finished session, created at `createdAt` and stored with its UTC day and week. */
function session(id: string, createdAt: string, tokens: number): AnalyticsRawSession {
  const day = createdAt.slice(0, 10);
  return {
    id,
    agent: 'codex-auto',
    model: 'gpt-5',
    contextWindow: null,
    harness: 'codex',
    mode: 'auto',
    status: 'completed',
    label: null,
    cwd: '/work/a',
    parent: null,
    tree: null,
    day,
    week: day,
    createdAt,
    pricingModel: 'gpt-5',
    equivalentApiCostUsdMicros: null,
    tokens,
    inputTokens: tokens,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: null,
    cacheWrite5mInputTokens: null,
    cacheWrite1hInputTokens: null,
    reasoningTokens: 0,
    turns: 1,
    durationMs: 1,
    activeDurationMs: 1,
    machine: null,
    timeToFirstOutputMs: null,
    contextEndPercent: null,
    stalled: false,
    failed: false,
    completed: true,
  } as AnalyticsRawSession;
}

describe('zoned days', () => {
  it('should put a late-evening UTC instant on the next day east of UTC and the same day west of it', () => {
    // Arrange
    const instant = '2026-10-14T20:30:00.000Z';

    // Act / Assert
    should(zonedDay(instant, 'UTC')).equal('2026-10-14');
    should(zonedDay(instant, 'Asia/Singapore')).equal('2026-10-15');
    should(zonedDay(instant, 'America/Los_Angeles')).equal('2026-10-14');
    should(zonedDay('not an instant', 'UTC')).equal(null);
  });

  it('should start a week on Monday in the zone, not in UTC', () => {
    // Sunday 2026-10-18 23:00Z is already Monday 2026-10-19 in Singapore.
    should(zonedWeek('2026-10-18T23:00:00.000Z', 'UTC')).equal('2026-10-12');
    should(zonedWeek('2026-10-18T23:00:00.000Z', 'Asia/Singapore')).equal('2026-10-19');
  });

  it('should follow daylight saving: a spring-forward day is 23 hours long', () => {
    // US spring forward 2026-03-08: local midnight to next local midnight spans 23 hours.
    const start = zonedMidnight('2026-03-08', 'America/New_York');
    const next = zonedMidnight('2026-03-09', 'America/New_York');
    should(new Date(start).toISOString()).equal('2026-03-08T05:00:00.000Z');
    should((next - start) / 3_600_000).equal(23);
  });

  it('should find the first instant of a day whose midnight does not exist', () => {
    // Sao Paulo skipped 00:00 on 2018-11-04 (clocks went 00:00 -> 01:00).
    const start = zonedMidnight('2018-11-04', 'America/Sao_Paulo');
    should(zonedDay(new Date(start).toISOString(), 'America/Sao_Paulo')).equal('2018-11-04');
    should(zonedDay(new Date(start - 60_000).toISOString(), 'America/Sao_Paulo')).equal('2018-11-03');
  });

  it.each([
    ['Asia/Gaza', '2020-10-24', '2020-10-23T21:00:00.000Z'],
    ['Asia/Amman', '2021-10-29', '2021-10-28T21:00:00.000Z'],
  ])('should start %s on %s at its FIRST midnight when the clock repeats it', (zone, date, first) => {
    // The clock goes back from 01:00 to 00:00, so midnight is read twice; the day starts at the first.
    const start = zonedMidnight(date, zone);
    should(new Date(start).toISOString()).equal(first);
    should(zonedDay(new Date(start).toISOString(), zone)).equal(date);
    should(zonedDay(new Date(start - 60_000).toISOString(), zone)).equal(
      new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10),
    );
  });

  it('should accept IANA names and refuse abbreviations, offsets and junk', () => {
    should(isTimeZone('Asia/Singapore')).equal(true);
    should(isTimeZone('UTC')).equal(true);
    should(isTimeZone('SGT')).equal(false);
    should(isTimeZone('+08:00')).equal(false);
    should(isTimeZone('')).equal(false);
    should(isTimeZone('Mars/Olympus_Mons')).equal(false);
  });

  it('should refuse the legacy fixed-offset names Intl accepts', () => {
    // EST is UTC-05 all year: it would count a New York reader's summer days an hour wrong.
    for (const name of ['EST', 'PST', 'MST', 'GMT+8', 'GMT', 'EST5EDT']) should(isTimeZone(name)).equal(false);
  });

  it('should accept both spellings of a zone, whichever one the engine lists', () => {
    // Arrange — Node lists Asia/Calcutta where Bun lists Asia/Kolkata; neither list may decide the answer
    const intl = Intl as { supportedValuesOf?: unknown };
    const original = intl.supportedValuesOf;
    try {
      for (const listed of [['Asia/Calcutta'], ['Asia/Kolkata'], []]) {
        intl.supportedValuesOf = () => listed;

        // Act / Assert
        for (const name of ['Asia/Calcutta', 'Asia/Kolkata', 'US/Pacific', 'Etc/UTC', 'Etc/GMT', 'UTC']) {
          should(isTimeZone(name)).equal(true);
        }
        for (const name of [
          'EST',
          'PST',
          'GMT+8',
          'SGT',
          '+08:00',
          'Mars/Olympus_Mons',
          '',
          ' Asia/Singapore',
          'Asia/Singapore ',
        ]) {
          should(isTimeZone(name)).equal(false);
        }
      }
    } finally {
      intl.supportedValuesOf = original;
    }
  });
});

describe('queryAnalyticsRecords in a time zone', () => {
  const records = [
    session('late', '2026-10-14T20:30:00.000Z', 10),
    session('early', '2026-10-15T01:00:00.000Z', 20),
    session('noon', '2026-10-15T12:00:00.000Z', 40),
  ];
  const days = (response: ReturnType<typeof queryAnalyticsRecords>): Record<string, number | null> => {
    if (response.kind !== 'aggregate') throw new Error('expected aggregate result');
    return Object.fromEntries(response.results.map(row => [String(row.labels['day']), row.tokens.value]));
  };

  it('should group by the UTC day when no zone is named', () => {
    should(days(queryAnalyticsRecords(records, 'sum(tokens) by (day)', { index }))).deepEqual({
      '2026-10-14': 10,
      '2026-10-15': 60,
    });
  });

  it('should group by the reader’s day when a zone is named', () => {
    // In Singapore (+08:00) the first two sessions are both on the 15th at 04:30 and 09:00.
    const actual = days(queryAnalyticsRecords(records, 'sum(tokens) by (day)', { index, timeZone: 'Asia/Singapore' }));
    should(actual).deepEqual({ '2026-10-15': 70 });
  });

  it('should filter a day matcher on the reader’s day too', () => {
    const response = queryAnalyticsRecords(records, 'sum(tokens) {day=2026-10-14}', {
      index,
      timeZone: 'America/Los_Angeles',
    });
    if (response.kind !== 'aggregate') throw new Error('expected aggregate result');
    // Only 'late' (13:30 on the 14th in LA) and 'early' (18:00 on the 14th) are the 14th there.
    should(response.results[0]!.tokens.value).equal(30);
  });

  it('should read a whole-day range on the zone’s clock', () => {
    // [2026-10-15..2026-10-15] is 2026-10-14T16:00Z .. 2026-10-15T16:00Z in Singapore: all three sessions.
    const sg = queryAnalyticsRecords(records, 'sum(tokens) [2026-10-15..2026-10-15]', {
      index,
      timeZone: 'Asia/Singapore',
    });
    const utc = queryAnalyticsRecords(records, 'sum(tokens) [2026-10-15..2026-10-15]', { index });
    if (sg.kind !== 'aggregate' || utc.kind !== 'aggregate') throw new Error('expected aggregate result');
    should(sg.results[0]!.tokens.value).equal(70);
    should(utc.results[0]!.tokens.value).equal(60);
    should(sg.scope.window).deepEqual({ from: '2026-10-14T16:00:00.000Z', to: '2026-10-15T16:00:00.000Z' });
  });

  it('should move only date bounds to the zone, and read an instant on a UTC midnight exactly', () => {
    // Arrange — the same two instants written as instants, then as dates
    const inZone = { index, timeZone: 'Asia/Singapore' };

    // Act
    const instants = queryAnalyticsRecords(records, 'sum(tokens) [2026-10-14T23:00:00Z..2026-10-15T00:00:00Z]', inZone);
    const midnight = queryAnalyticsRecords(records, 'sum(tokens) [2026-10-14T00:00:00Z..2026-10-15T00:00:00Z]', inZone);
    const mixed = queryAnalyticsRecords(records, 'sum(tokens) [2026-10-15..2026-10-15T12:00:00Z]', inZone);
    const dates = queryAnalyticsRecords(records, 'sum(tokens) [2026-10-14..2026-10-14]', inZone);

    // Assert
    if (
      instants.kind !== 'aggregate' ||
      midnight.kind !== 'aggregate' ||
      mixed.kind !== 'aggregate' ||
      dates.kind !== 'aggregate'
    ) {
      throw new Error('expected aggregate result');
    }
    should(instants.scope.window).deepEqual({ from: '2026-10-14T23:00:00.000Z', to: '2026-10-15T00:00:00.000Z' });
    should(midnight.scope.window).deepEqual({ from: '2026-10-14T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' });
    // A date start opens at Singapore's midnight (the 14th, 16:00Z the day before); an instant end is exact.
    should(mixed.scope.window).deepEqual({ from: '2026-10-14T16:00:00.000Z', to: '2026-10-15T12:00:00.000Z' });
    should(dates.scope.window).deepEqual({ from: '2026-10-13T16:00:00.000Z', to: '2026-10-14T16:00:00.000Z' });
    should(mixed.results[0]!.tokens.value).equal(30);
  });

  it('should refuse a window the zone inverts, rather than answer a different one', () => {
    // [2026-10-15T20:00Z..2026-10-15] closes at Singapore's midnight, 2026-10-15T16:00Z, before 20:00Z.
    const source = 'sum(tokens) [2026-10-15T20:00:00Z..2026-10-15]';

    should(() => queryAnalyticsRecords(records, source, { index, timeZone: 'Asia/Singapore' })).throw(
      AnalyticsQueryError,
      { message: 'a range must end after it starts' },
    );
    // Without a zone the same range is as inverted as it reads.
    should(() => queryAnalyticsRecords(records, 'sum(tokens) [2026-10-15..2026-10-14T20:00:00Z]', { index })).throw(
      AnalyticsQueryError,
    );
  });

  it('should order a mixed range on the zone\u2019s clock: empty in UTC terms, four hours in Singapore', () => {
    // 2026-10-15 is 2026-10-14T16:00Z in Singapore, so [..2026-10-14T20:00Z] is a four-hour window.
    const response = queryAnalyticsRecords(records, 'sum(tokens) [2026-10-15..2026-10-14T20:00:00Z]', {
      index,
      timeZone: 'Asia/Singapore',
    });
    if (response.kind !== 'aggregate') throw new Error('expected aggregate result');
    should(response.scope.window).deepEqual({ from: '2026-10-14T16:00:00.000Z', to: '2026-10-14T20:00:00.000Z' });
    should(response.scope.matched).equal(0);
  });

  it('should answer an empty window, not a UTC day, for a day the zone skipped', () => {
    // Pacific/Apia skipped 2011-12-30: a session either side of it is on neither day there.
    const apia = [
      session('before', '2011-12-29T12:00:00.000Z', 1),
      session('after', '2011-12-31T12:00:00.000Z', 2),
      session('on-utc-30th', '2011-12-30T12:00:00.000Z', 4),
    ];
    const inApia = { index, timeZone: 'Pacific/Apia' };

    const range = queryAnalyticsRecords(apia, 'sum(tokens) [2011-12-30..2011-12-30]', inApia);
    const day = queryAnalyticsRecords(apia, 'sum(tokens) {day=2011-12-30}', inApia);

    if (range.kind !== 'aggregate' || day.kind !== 'aggregate') throw new Error('expected aggregate result');
    should(range.scope.matched).equal(0);
    should(range.scope.window!.from).equal(range.scope.window!.to);
    should(day.scope.matched).equal(0);
  });

  it('should give raw rows the reader\u2019s day and week as well', () => {
    const response = queryAnalyticsRecords([session('late', '2026-10-14T20:30:00.000Z', 10)], '{}', {
      index,
      timeZone: 'Asia/Singapore',
    });
    if (response.kind !== 'raw') throw new Error('expected raw result');
    should(response.results[0]).have.properties({ day: '2026-10-15', week: '2026-10-12' });
  });

  it('should leave a session with no creation instant on the day it was stored with', () => {
    const orphan = { ...session('orphan', '2026-10-15T01:00:00.000Z', 5), createdAt: null, day: '2026-10-13' };
    const actual = days(queryAnalyticsRecords([orphan], 'sum(tokens) by (day)', { index, timeZone: 'Asia/Singapore' }));
    should(actual).deepEqual({ '2026-10-13': 5 });
  });
});
