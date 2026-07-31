import { describe, expect, it } from 'bun:test';
import {
  ACTIVE_BONUS,
  FIELD_WEIGHTS,
  fieldScore,
  MAX_SESSION_RESULTS,
  RECENT_SESSION_COUNT,
  rankSessions,
  recentSessions,
  scoreFields,
  SUBSEQUENCE_SCORE,
  SUBSTRING_SCORE,
  sessionBonus,
  WORD_START_SCORE,
  type SessionEntry,
} from '../../src/shell/palette-ranking.ts';

const entry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  id: 'ab12cd34-teammate',
  teammate: 'jessica',
  task: 'port the palette',
  label: 'shell',
  folder: 'ferretry /home/k/Workspace/ferretry',
  activityAt: 0,
  active: false,
  finished: false,
  ...overrides,
});

describe('fieldScore', () => {
  it('rejects an empty haystack or an empty needle', () => {
    expect(fieldScore('   ', 'jess')).toBe(0);
    expect(fieldScore('jessica', '   ')).toBe(0);
  });

  it('scores a query that begins the value as a word start', () => {
    expect(fieldScore('jessica', 'jess')).toBe(WORD_START_SCORE);
  });

  it('scores a word start found after an earlier non-word-start occurrence', () => {
    // The first `n` in the path is mid-word; the last segment starts with one.
    expect(fieldScore('/home/k/Workspace/anitro/nitroso', 'nitroso')).toBe(WORD_START_SCORE);
  });

  it('scores a substring that never begins a word below a word start', () => {
    expect(fieldScore('transcript', 'ranscrip')).toBe(SUBSTRING_SCORE);
  });

  it('scores an in-order subsequence on its TIGHTEST window, not the first one found', () => {
    // A greedy left-to-right scan starts at index 0 and spans 10 characters; the
    // window this really abbreviates starts at index 6 and spans 4. A trailing
    // `a` that cannot complete the match must not disturb either.
    expect(fieldScore('a-zzz-ab-c-a', 'abc')).toBe(SUBSEQUENCE_SCORE * (3 / 4));
  });

  it('scores a loose subsequence below a substring', () => {
    const loose = fieldScore('transcript', 'tsp');
    expect(loose).toBeGreaterThan(0);
    expect(loose).toBeLessThan(SUBSTRING_SCORE);
  });

  it('returns nothing when the needle is not even a subsequence', () => {
    expect(fieldScore('transcript', 'zzz')).toBe(0);
  });

  it('answers an anchored field only at a word start', () => {
    expect(fieldScore('ab12cd34-teammate', 'ab12', { anchored: true })).toBe(WORD_START_SCORE);
    expect(fieldScore('ab12cd34-teammate', 'teammate', { anchored: true })).toBe(WORD_START_SCORE);
  });

  it('refuses an anchored field a loose match', () => {
    expect(fieldScore('ab12cd34-teammate', '2cd3', { anchored: true })).toBe(0);
    expect(fieldScore('ab12cd34-teammate', 'a1c3', { anchored: true })).toBe(0);
  });

  it('matches regardless of the casing on either side', () => {
    expect(fieldScore('Jessica', 'JESS')).toBe(WORD_START_SCORE);
  });
});

describe('scoreFields', () => {
  it('scores nothing for a query with no terms', () => {
    expect(scoreFields([{ value: 'jessica', weight: 3 }], '   ')).toBe(0);
  });

  it('weights the winning field and adds only a residual from the others', () => {
    const both = scoreFields(
      [
        { value: 'jessica', weight: FIELD_WEIGHTS.teammate },
        { value: 'jessica', weight: FIELD_WEIGHTS.task },
      ],
      'jess',
    );
    const one = scoreFields([{ value: 'jessica', weight: FIELD_WEIGHTS.teammate }], 'jess');

    expect(both).toBeGreaterThan(one);
    // The residual is too small to promote a second weak field over a strong one.
    expect(both).toBeLessThan(one * 1.1);
  });

  it('keeps a stronger field ahead of a weaker one carrying the same match', () => {
    const strong = scoreFields([{ value: 'jessica', weight: FIELD_WEIGHTS.teammate }], 'jess');
    const weak = scoreFields([{ value: 'jessica', weight: FIELD_WEIGHTS.folder }], 'jess');

    expect(strong).toBeGreaterThan(weak);
  });

  it('requires every term of a multi-term query to match something', () => {
    const fields = [
      { value: 'jessica', weight: FIELD_WEIGHTS.teammate },
      { value: 'port the palette', weight: FIELD_WEIGHTS.task },
    ];

    expect(scoreFields(fields, 'jessica palette')).toBeGreaterThan(0);
    expect(scoreFields(fields, 'jessica zzzz')).toBe(0);
  });

  it('keeps a two-term query on the same scale as a one-term query', () => {
    const fields = [{ value: 'port the palette', weight: FIELD_WEIGHTS.task }];

    expect(scoreFields(fields, 'port palette')).toBeCloseTo(scoreFields(fields, 'port'), 5);
  });
});

describe('sessionBonus', () => {
  const now = 1_700_000_000_000;

  it('rewards a session doing live work', () => {
    expect(sessionBonus(entry({ active: true }), now)).toBe(ACTIVE_BONUS);
    expect(sessionBonus(entry({ active: false }), now)).toBe(0);
  });

  it('walks the recency ladder from the narrowest window', () => {
    expect(sessionBonus(entry({ activityAt: now - 60_000 }), now)).toBe(25);
    expect(sessionBonus(entry({ activityAt: now - 30 * 60_000 }), now)).toBe(15);
    expect(sessionBonus(entry({ activityAt: now - 6 * 60 * 60_000 }), now)).toBe(5);
    expect(sessionBonus(entry({ activityAt: now - 48 * 60 * 60_000 }), now)).toBe(0);
  });

  it('ignores an unknown or future life sign rather than inventing recency', () => {
    expect(sessionBonus(entry({ activityAt: 0 }), now)).toBe(0);
    expect(sessionBonus(entry({ activityAt: now + 60_000 }), now)).toBe(0);
  });

  it('adds the live-work and recency bonuses together', () => {
    expect(sessionBonus(entry({ active: true, activityAt: now - 60_000 }), now)).toBe(ACTIVE_BONUS + 25);
  });
});

describe('rankSessions', () => {
  const now = 1_700_000_000_000;

  it('drops everything the query does not match', () => {
    const rows = [
      entry({ id: 'a', teammate: 'jessica' }),
      entry({ id: 'b', teammate: 'meghan', task: '', folder: '' }),
    ];

    expect(rankSessions(rows, 'jess', { now }).map(one => one.id)).toEqual(['a']);
  });

  it('puts the stronger field match first', () => {
    const rows = [
      entry({ id: 'folder-hit', teammate: 'meghan', task: '', folder: 'palette' }),
      entry({ id: 'teammate-hit', teammate: 'palette', task: '', folder: '' }),
    ];

    expect(rankSessions(rows, 'palette', { now }).map(one => one.id)).toEqual(['teammate-hit', 'folder-hit']);
  });

  it('breaks a score tie on the newer life sign, then on input order', () => {
    const rows = [
      entry({ id: 'older', teammate: 'jessica', activityAt: now - 48 * 60 * 60_000 }),
      entry({ id: 'newer', teammate: 'jessica', activityAt: now - 47 * 60 * 60_000 }),
      entry({ id: 'same', teammate: 'jessica', activityAt: now - 47 * 60 * 60_000 }),
    ];

    expect(rankSessions(rows, 'jess', { now }).map(one => one.id)).toEqual(['newer', 'same', 'older']);
  });

  it('caps the visible rows at the shared maximum', () => {
    const rows = Array.from({ length: MAX_SESSION_RESULTS + 4 }, (_, index) =>
      entry({ id: `session-${index}`, teammate: 'jessica' }),
    );

    expect(rankSessions(rows, 'jess', { now })).toHaveLength(MAX_SESSION_RESULTS);
    expect(rankSessions(rows, 'jess', { now, limit: 2 })).toHaveLength(2);
  });

  it('ranks against the current clock when none is supplied', () => {
    const rows = [entry({ id: 'live', teammate: 'jessica', activityAt: Date.now() })];

    expect(rankSessions(rows, 'jess').map(one => one.id)).toEqual(['live']);
  });

  it('finds a session by the start of its id and not by the middle of it', () => {
    const rows = [entry({ id: 'ab12cd34-teammate', teammate: '', task: '', label: '', folder: '' })];

    expect(rankSessions(rows, 'ab12', { now })).toHaveLength(1);
    expect(rankSessions(rows, '2cd3', { now })).toHaveLength(0);
  });
});

describe('recentSessions', () => {
  it('offers live work newest-first, then finished sessions', () => {
    const rows = [
      entry({ id: 'finished-new', finished: true, activityAt: 900 }),
      entry({ id: 'live-old', activityAt: 100 }),
      entry({ id: 'live-new', activityAt: 500 }),
      entry({ id: 'finished-old', finished: true, activityAt: 50 }),
    ];

    expect(recentSessions(rows).map(one => one.id)).toEqual(['live-new', 'live-old', 'finished-new', 'finished-old']);
  });

  it('keeps input order for two sessions with the same life sign', () => {
    const rows = [entry({ id: 'first', activityAt: 100 }), entry({ id: 'second', activityAt: 100 })];

    expect(recentSessions(rows).map(one => one.id)).toEqual(['first', 'second']);
  });

  it('caps at the recents count by default and at an explicit limit', () => {
    const rows = Array.from({ length: RECENT_SESSION_COUNT + 3 }, (_, index) =>
      entry({ id: `session-${index}`, activityAt: index }),
    );

    expect(recentSessions(rows)).toHaveLength(RECENT_SESSION_COUNT);
    expect(recentSessions(rows, 2)).toHaveLength(2);
  });
});
