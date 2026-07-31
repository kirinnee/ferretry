import { describe, it } from 'bun:test';
import should from 'should';
import {
  activeBlessing,
  blessingTtlMs,
  isAnomalyBlessed,
  MINIMUM_BLESSING_MS,
  reconcileBlessings,
  recordBlessing,
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
