import { describe, it } from 'bun:test';
import type { WardenDayStats, WardenJevCheck } from '@ferretry/protocol';
import should from 'should';
import type { TriageDecision } from '../../../src/lib/speedups/jev.ts';
import {
  capSkipKey,
  countJevCheck,
  emptyWardenDay,
  EMPTY_JEV_DAY,
  expiredJevCheckFiles,
  JEV_CHECK_KEEP_DAYS,
  jevCapSkipOf,
  jevCheckDay,
  jevCheckFileDay,
  jevCheckFileName,
  jevCheckFilesNewestFirst,
  jevCheckLine,
  jevCheckOf,
  parseJevCheckLines,
  pruneCapSkips,
  recordWardenJevCheck,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const anomaly = { sessionId: 's1', kind: 'sus_thinking' as const, status: 'running' as const };
const decision: TriageDecision = {
  verdict: 'unsure',
  confidence: 0.4,
  model: 'jev-latest',
  inputTokens: 900,
  latencyMs: 80,
  costUsd: 0.0004,
};
const check = (overrides: Partial<WardenJevCheck> = {}): WardenJevCheck => ({
  at: '2026-10-30T12:00:00.000Z',
  sessionId: 's1',
  anomalyKind: 'sus_thinking',
  verdict: 'healthy',
  confidence: 0.9,
  costUsd: 0.0004,
  ...overrides,
});

describe('the Jev check files', () => {
  it('should keep one file per UTC day and know which names are one', () => {
    // Act / Assert
    should(jevCheckFileName('2026-10-30')).equal('2026-10-30.jsonl');
    should(jevCheckFileDay('2026-10-30.jsonl')).equal('2026-10-30');
    should(jevCheckFileDay('.tmp-2026-10-30.jsonl')).be.undefined();
    should(jevCheckFileDay('notes.md')).be.undefined();
  });

  it('should expire only the days past the keep window, today counted', () => {
    // Arrange: the window is the thirty days ending today, so 2026-10-01 is the oldest kept.
    const names = ['2026-09-30.jsonl', '2026-10-01.jsonl', '2026-10-30.jsonl', 'README'];

    // Act
    const actual = expiredJevCheckFiles(names, NOW);

    // Assert
    should(JEV_CHECK_KEEP_DAYS).equal(30);
    should(actual).deepEqual(['2026-09-30.jsonl']);
  });

  it('should read the newest day first, and only day files', () => {
    // Act
    const actual = jevCheckFilesNewestFirst(['2026-10-28.jsonl', 'x.tmp', '2026-10-30.jsonl', '2026-10-29.jsonl']);

    // Assert
    should(actual).deepEqual(['2026-10-30.jsonl', '2026-10-29.jsonl', '2026-10-28.jsonl']);
  });

  it('should write one line per check and read a day back newest first, skipping what does not parse', () => {
    // Arrange
    const first = check({ at: '2026-10-30T10:00:00.000Z' });
    const second = check({ at: '2026-10-30T11:00:00.000Z', verdict: 'handed_on', why: 'unsure', route: 'owner' });
    const text = `${jevCheckLine(first)}{"torn":\n\n${JSON.stringify({ at: 'nope' })}\n${jevCheckLine(second)}`;

    // Act
    const actual = parseJevCheckLines(text);

    // Assert
    should(jevCheckLine(first)).endWith('}\n');
    should(actual).deepEqual([second, first]);
  });
});

describe('a Jev check', () => {
  it('should record a confident leave as healthy', () => {
    // Act
    const actual = jevCheckOf({
      anomaly,
      decision,
      outcome: { kind: 'leave', confidence: 0.95 },
      route: 'investigation',
      nowMs: NOW,
    });

    // Assert
    should(actual).deepEqual(check({ confidence: 0.95 }));
  });

  it('should record an act that took as acted, and one that did not as handed on', () => {
    // Arrange
    const outcome = { kind: 'act' as const, act: 'restart' as const, confidence: 0.97, reason: 'frozen' };

    // Act
    const took = jevCheckOf({ anomaly, decision, outcome, route: 'owner', took: true, nowMs: NOW });
    const refused = jevCheckOf({ anomaly, decision, outcome, route: 'owner', took: false, nowMs: NOW });

    // Assert
    should(took).deepEqual(check({ verdict: 'acted', act: 'restart', confidence: 0.97 }));
    should(refused).deepEqual(
      check({ verdict: 'handed_on', act: 'restart', why: 'act_failed', route: 'owner', confidence: 0.97 }),
    );
  });

  it('should record a hand-on with why and where, and the act Jev recommended when it had one', () => {
    // Act
    const unsure = jevCheckOf({
      anomaly,
      decision,
      outcome: { kind: 'escalate', why: 'unsure', confidence: 0.4 },
      route: 'investigation',
      nowMs: NOW,
    });
    const recommended = jevCheckOf({
      anomaly,
      decision: { ...decision, costUsd: undefined },
      outcome: { kind: 'escalate', why: 'never_alone', confidence: 0.99, recommends: 'stop' },
      route: 'owner',
      nowMs: NOW,
    });

    // Assert
    should(unsure).deepEqual(check({ verdict: 'handed_on', why: 'unsure', route: 'investigation', confidence: 0.4 }));
    should(recommended).deepEqual(
      check({ verdict: 'handed_on', why: 'never_alone', route: 'owner', act: 'stop', confidence: 0.99, costUsd: 0 }),
    );
  });

  it('should record a cap skip as free and unsure', () => {
    // Act
    const actual = jevCapSkipOf(anomaly, 'jev_paced', 'investigation', NOW);

    // Assert
    should(actual).deepEqual(
      check({ verdict: 'skipped', why: 'jev_paced', route: 'investigation', confidence: 0, costUsd: 0 }),
    );
  });
});

describe('counting Jev checks', () => {
  it.each([
    ['healthy', { ...EMPTY_JEV_DAY, checks: 1, healthy: 1 }],
    ['acted', { ...EMPTY_JEV_DAY, checks: 1, acted: 1 }],
    ['handed_on', { ...EMPTY_JEV_DAY, checks: 1, handedOn: 1 }],
    ['skipped', { ...EMPTY_JEV_DAY, skippedForCap: 1 }],
  ] as const)('should count a %s check into its day', (verdict, expected) => {
    // Act
    const actual = countJevCheck(emptyWardenDay('2026-10-30'), check({ verdict }));

    // Assert
    should(actual.jev).deepEqual(expected);
  });

  it('should add to a day that already has checks', () => {
    // Arrange
    const day: WardenDayStats = { ...emptyWardenDay('2026-10-30'), jev: { ...EMPTY_JEV_DAY, checks: 4, healthy: 4 } };

    // Act
    const actual = countJevCheck(day, check());

    // Assert
    should(actual.jev).match({ checks: 5, healthy: 5 });
  });

  it('should count a check into the state on the day it was made, and ignore one with no readable time', () => {
    // Arrange
    const state = { daily: [emptyWardenDay('2026-10-29')] };

    // Act
    const actual = recordWardenJevCheck(state, check());
    const unreadable = recordWardenJevCheck(state, check({ at: 'yesterday' }));

    // Assert
    should(actual.daily?.map(day => [day.day, day.jev?.checks])).deepEqual([
      ['2026-10-29', undefined],
      ['2026-10-30', 1],
    ]);
    should(unreadable).equal(state);
    should(jevCheckDay({ at: 'yesterday' })).be.undefined();
  });
});

describe('remembering cap skips', () => {
  it('should keep today’s skips for flags still standing in the same status, and drop the rest', () => {
    // Arrange
    const kept = capSkipKey(anomaly, '2026-10-30');
    const yesterday = capSkipKey(anomaly, '2026-10-29');
    const moved = capSkipKey({ ...anomaly, status: 'awaiting_user' }, '2026-10-30');
    const gone = capSkipKey({ ...anomaly, sessionId: 's2' }, '2026-10-30');

    // Act
    const actual = pruneCapSkips([kept, yesterday, moved, gone], [anomaly], NOW);

    // Assert
    should(actual).deepEqual([kept]);
  });
});
