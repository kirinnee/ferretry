import { describe, it } from 'bun:test';
import should from 'should';
import {
  activeBlessing,
  BLESSING_CEILING_MS,
  blessingTtlMs,
  clearStreak,
  growingBlessingMs,
  isAnomalyBlessed,
  mergeBlessing,
  MINIMUM_BLESSING_MS,
  reconcileBlessings,
  reconcileClearStreaks,
  recordBlessing,
  recordClears,
  type BlessingStore,
  type WardenSessionStatus,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const blessed = (overrides: Partial<BlessingStore['x']> = {}): BlessingStore => ({
  s1: {
    sessionId: 's1',
    kinds: ['sus_thinking'],
    status: 'thinking',
    blessedAt: at(-5),
    expiresAt: at(10),
    ...overrides,
  },
});

const statuses = (entries: Record<string, WardenSessionStatus>): ReadonlyMap<string, WardenSessionStatus> =>
  new Map(Object.entries(entries));

describe('blessing lifetimes', () => {
  it.each([
    { label: 'a configured lifetime', minutes: 15, expected: 15 * 60_000 },
    { label: 'a zero lifetime floored to a minute', minutes: 0, expected: MINIMUM_BLESSING_MS },
    { label: 'a negative lifetime floored to a minute', minutes: -10, expected: MINIMUM_BLESSING_MS },
    { label: 'a nonsense lifetime floored to a minute', minutes: Number.NaN, expected: MINIMUM_BLESSING_MS },
    { label: 'a fractional lifetime', minutes: 1.5, expected: 90_000 },
  ])('should turn $label into milliseconds', ({ minutes, expected }) => {
    // Arrange / Act / Assert
    should(blessingTtlMs(minutes)).eql(expected);
  });
});

describe('active blessings', () => {
  it('should return a blessing that has not yet lapsed', () => {
    // Arrange / Act / Assert
    should(activeBlessing(blessed(), 's1', NOW)?.sessionId).eql('s1');
  });

  it.each([
    { label: 'a lapsed blessing', store: blessed({ expiresAt: at(-1) }), sessionId: 's1' },
    { label: 'a blessing with an unreadable expiry', store: blessed({ expiresAt: 'soon' }), sessionId: 's1' },
    { label: 'a session that was never blessed', store: blessed(), sessionId: 'other' },
  ])('should return nothing for $label', ({ store, sessionId }) => {
    // Arrange / Act / Assert
    should(activeBlessing(store, sessionId, NOW)).be.undefined();
  });
});

describe('blessing coverage', () => {
  it('should suppress an anomaly of a kind the warden cleared', () => {
    // Arrange / Act
    const suppressed = isAnomalyBlessed(blessed(), { sessionId: 's1', kind: 'sus_thinking' }, 'thinking', NOW);

    // Assert
    should(suppressed).be.true();
  });

  it('should not suppress a different anomaly kind on the same session', () => {
    // Arrange / Act
    const suppressed = isAnomalyBlessed(blessed(), { sessionId: 's1', kind: 'dead_monitor' }, 'thinking', NOW);

    // Assert
    should(suppressed).be.false();
  });

  it('should not suppress once the session has changed status', () => {
    // Arrange / Act
    const suppressed = isAnomalyBlessed(blessed(), { sessionId: 's1', kind: 'sus_thinking' }, 'failed', NOW);

    // Assert
    should(suppressed).be.false();
  });

  it('should not suppress after the blessing lapses', () => {
    // Arrange
    const store = blessed({ expiresAt: at(-1) });

    // Act / Assert
    should(isAnomalyBlessed(store, { sessionId: 's1', kind: 'sus_thinking' }, 'thinking', NOW)).be.false();
  });

  it('should not suppress a session nobody blessed', () => {
    // Arrange / Act / Assert
    should(isAnomalyBlessed({}, { sessionId: 's1', kind: 'sus_thinking' }, 'thinking', NOW)).be.false();
  });
});

describe('recording a blessing', () => {
  it('should record the cleared kinds, status and expiry', () => {
    // Arrange / Act
    const store = recordBlessing(
      {},
      { sessionId: 's1', kinds: ['sus_thinking'], status: 'thinking', wardenId: 'wd-1' },
      NOW,
      15 * 60_000,
    );

    // Assert
    should(store['s1']).eql({
      sessionId: 's1',
      kinds: ['sus_thinking'],
      status: 'thinking',
      blessedAt: at(0),
      expiresAt: at(15),
      wardenId: 'wd-1',
    });
  });

  it('should de-duplicate repeated kinds', () => {
    // Arrange / Act
    const store = recordBlessing(
      {},
      { sessionId: 's1', kinds: ['sus_thinking', 'sus_thinking', 'sus_subprocess'], status: 'thinking' },
      NOW,
      60_000,
    );

    // Assert
    should(store['s1']?.kinds).eql(['sus_thinking', 'sus_subprocess']);
  });

  it('should omit the warden when the caller did not name one', () => {
    // Arrange / Act
    const store = recordBlessing({}, { sessionId: 's1', kinds: ['sus_thinking'], status: 'thinking' }, NOW, 60_000);

    // Assert
    should(store['s1']?.wardenId).be.undefined();
  });

  it('should ignore a request that clears nothing', () => {
    // Arrange
    const store: BlessingStore = {};

    // Act / Assert
    should(recordBlessing(store, { sessionId: 's1', kinds: [], status: 'thinking' }, NOW, 60_000)).be.exactly(store);
  });

  it('should replace an earlier blessing for the same session', () => {
    // Arrange
    const store = blessed();

    // Act
    const next = recordBlessing(store, { sessionId: 's1', kinds: ['sus_subprocess'], status: 'running' }, NOW, 60_000);

    // Assert
    should(next['s1']?.kinds).eql(['sus_subprocess']);
    should(next['s1']?.status).eql('running');
  });

  it('should never grant an already-expired blessing', () => {
    // Arrange / Act
    const store = recordBlessing({}, { sessionId: 's1', kinds: ['sus_thinking'], status: 'thinking' }, NOW, -5_000);

    // Assert
    should(store['s1']?.expiresAt).eql(at(1));
  });

  it('should leave other sessions untouched', () => {
    // Arrange
    const store = blessed();

    // Act
    const next = recordBlessing(store, { sessionId: 's2', kinds: ['dead_monitor'], status: 'running' }, NOW, 60_000);

    // Assert
    should(Object.keys(next).toSorted()).eql(['s1', 's2']);
  });
});

describe('blessing reconciliation', () => {
  it('should keep a live blessing whose session has not moved', () => {
    // Arrange / Act
    const result = reconcileBlessings(blessed(), statuses({ s1: 'thinking' }), NOW);

    // Assert
    should(Object.keys(result.store)).eql(['s1']);
    should(result.revoked).be.empty();
    should(result.expired).be.empty();
  });

  it('should expire a lapsed blessing', () => {
    // Arrange / Act
    const result = reconcileBlessings(blessed({ expiresAt: at(-1) }), statuses({ s1: 'thinking' }), NOW);

    // Assert
    should(result.store).be.empty();
    should(result.expired).eql(['s1']);
    should(result.revoked).be.empty();
  });

  it('should expire a blessing whose expiry cannot be read rather than keep it forever', () => {
    // Arrange / Act
    const result = reconcileBlessings(blessed({ expiresAt: 'soon' }), statuses({ s1: 'thinking' }), NOW);

    // Assert
    should(result.expired).eql(['s1']);
  });

  it('should revoke a blessing when the session changes status', () => {
    // Arrange / Act
    const result = reconcileBlessings(blessed(), statuses({ s1: 'failed' }), NOW);

    // Assert
    should(result.store).be.empty();
    should(result.revoked).eql(['s1']);
    should(result.expired).be.empty();
  });

  it('should revoke a blessing whose session has vanished', () => {
    // Arrange / Act
    const result = reconcileBlessings(blessed(), statuses({}), NOW);

    // Assert
    should(result.revoked).eql(['s1']);
  });

  it('should reconcile an empty store to an empty store', () => {
    // Arrange / Act
    const result = reconcileBlessings({}, statuses({}), NOW);

    // Assert
    should(result).eql({ store: {}, revoked: [], expired: [] });
  });
});

describe('the growing cooldown', () => {
  it.each([
    { label: 'a first clear', base: 15, streak: 0, minutes: 15 },
    { label: 'a second clear in a row', base: 15, streak: 1, minutes: 30 },
    { label: 'a fifth', base: 15, streak: 4, minutes: 240 },
    { label: 'a run past the ceiling', base: 15, streak: 9, minutes: 240 },
    { label: 'an absurd streak', base: 15, streak: 1_000, minutes: 240 },
    { label: 'a nonsense streak, read as none', base: 15, streak: Number.NaN, minutes: 15 },
    { label: 'a configured lifetime already over the ceiling', base: 300, streak: 3, minutes: 300 },
  ])('should leave $label alone for $minutes minutes', ({ base, streak, minutes }) => {
    // Act / Assert
    should(growingBlessingMs(base, streak)).equal(minutes * 60_000);
  });

  it('should cap the growth at four hours', () => {
    // Act / Assert
    should(BLESSING_CEILING_MS).equal(4 * 3_600_000);
  });
});

describe('clear streaks', () => {
  it('should count each clear of each kind, and the longest run among the kinds asked about', () => {
    // Arrange
    let store = recordClears({}, 's1', ['sus_thinking'], 'thinking');
    store = recordClears(store, 's1', ['sus_thinking', 'sus_subprocess', 'sus_subprocess'], 'thinking');

    // Act
    const actual = [
      clearStreak(store, 's1', ['sus_thinking'], 'thinking'),
      clearStreak(store, 's1', ['sus_subprocess'], 'thinking'),
      clearStreak(store, 's1', ['sus_subprocess', 'sus_thinking'], 'thinking'),
      clearStreak(store, 's1', ['dead_monitor'], 'thinking'),
      clearStreak(store, 's1', ['sus_thinking'], 'running'),
      clearStreak(store, 's2', ['sus_thinking'], 'thinking'),
    ];

    // Assert
    should(actual).deepEqual([2, 1, 2, 0, 0, 0]);
  });

  it('should start every count afresh in a new status, and ignore an empty clear', () => {
    // Arrange
    const store = recordClears({}, 's1', ['sus_thinking'], 'thinking');

    // Act
    const moved = recordClears(store, 's1', ['sus_subprocess'], 'running');
    const empty = recordClears(store, 's1', [], 'thinking');

    // Assert
    should(moved).deepEqual({ s1: { status: 'running', counts: { sus_subprocess: 1 } } });
    should(empty).equal(store);
  });

  it('should keep a streak only while its flag is raised or blessed, in the same status', () => {
    // Arrange
    const store = {
      s1: { status: 'thinking', counts: { sus_thinking: 2, sus_subprocess: 1, dead_monitor: 3 } },
      s2: { status: 'thinking', counts: { sus_thinking: 1 } },
      s3: { status: 'thinking', counts: { sus_thinking: 1 } },
      s4: { status: 'running', counts: { sus_thinking: 1 } },
    } as const;
    const blessings = blessed({ kinds: ['dead_monitor'] });

    // Act
    const actual = reconcileClearStreaks(
      store,
      statuses({ s1: 'thinking', s2: 'thinking', s4: 'thinking' }),
      [{ sessionId: 's1', kind: 'sus_thinking' }],
      blessings,
      NOW,
    );

    // Assert
    should(actual).deepEqual({ s1: { status: 'thinking', counts: { sus_thinking: 2, dead_monitor: 3 } } });
  });
});

describe('merging a blessing', () => {
  it('should join the kinds and keep the later expiry', () => {
    // Arrange
    const store = blessed({ expiresAt: at(60), untilChange: true });

    // Act
    const actual = mergeBlessing(
      store,
      { sessionId: 's1', kinds: ['sus_subprocess'], status: 'thinking' },
      NOW,
      600_000,
    );

    // Assert
    should(actual.s1).match({ kinds: ['sus_thinking', 'sus_subprocess'], expiresAt: at(60), untilChange: true });
  });

  it('should take the new expiry and its streak when it is later', () => {
    // Arrange
    const store = blessed({ expiresAt: at(5) });

    // Act
    const actual = mergeBlessing(
      store,
      { sessionId: 's1', kinds: ['sus_thinking'], status: 'thinking', by: 'jev', streak: 2 },
      NOW,
      3_600_000,
    );

    // Assert
    should(actual.s1).match({ kinds: ['sus_thinking'], expiresAt: at(60), by: 'jev', streak: 2 });
    should(actual.s1).not.have.property('untilChange');
  });

  it('should not join a blessing from another status, nor one that lapsed', () => {
    // Arrange
    const other = blessed({ status: 'running' });
    const lapsed = blessed({ expiresAt: at(-1) });
    const request = { sessionId: 's1', kinds: ['sus_subprocess'], status: 'thinking' } as const;

    // Act
    const actual = [mergeBlessing(other, request, NOW, 600_000), mergeBlessing(lapsed, request, NOW, 600_000)];

    // Assert
    should(actual.map(store => store.s1?.kinds)).deepEqual([['sus_subprocess'], ['sus_subprocess']]);
  });

  it('should record a streak and an until-change on a fresh blessing, and leave out a zero streak', () => {
    // Act
    const marked = recordBlessing(
      {},
      { sessionId: 's1', kinds: ['sus_thinking'], status: 'thinking', streak: 3, untilChange: true, by: 'owner' },
      NOW,
      600_000,
    );
    const plain = recordBlessing(
      {},
      { sessionId: 's1', kinds: ['sus_thinking'], status: 'thinking', streak: 0 },
      NOW,
      600_000,
    );

    // Assert
    should(marked.s1).match({ streak: 3, untilChange: true, by: 'owner' });
    should(plain.s1).not.have.properties(['streak', 'untilChange']);
  });
});
