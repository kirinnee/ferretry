import { describe, it } from 'bun:test';
import should from 'should';
import {
  activeCallsigns,
  availableCallsigns,
  DEFAULT_CALLSIGN_POOL,
  formatSessionTitle,
  isValidCallsignPool,
  normalizeCallsign,
  resolveSessionReference,
  suggestCallsigns,
} from '../../../src/lib/names/index.ts';

describe('callsign policy', () => {
  it.each([
    { input: 'Hayden', expected: 'hayden' },
    { input: '  Agent-7  ', expected: 'agent-7' },
    { input: 'a', expected: 'a' },
  ])('should normalize valid callsign "$input"', ({ input, expected }) => {
    // Act
    const actual = normalizeCallsign(input);

    // Assert
    should(actual).equal(expected);
  });

  it('should reject invalid callsigns without rewriting them', () => {
    // Arrange
    const input = ['', '   ', '7up', '-lead', 'has space', '[Hayden]', 'a'.repeat(33)];

    // Act
    const actual = input.map(normalizeCallsign);

    // Assert
    should(actual).deepEqual(input.map(() => null));
  });

  it('should preserve readable titles while flattening controls and enforcing the cap', () => {
    // Arrange
    const input = `  [Hayden]\n\tFix   ${'x'.repeat(200)}  `;

    // Act
    const actual = formatSessionTitle(input);

    // Assert
    should(actual).startWith('[Hayden] Fix ');
    should(actual).have.length(120);
  });

  it('should expose only unexpired claims as active', () => {
    // Arrange
    const input = [
      { callsign: 'Ada', ownerId: 'one', claimedAtMs: 10, expiresAtMs: 100 },
      { callsign: 'bert', ownerId: 'two', claimedAtMs: 20, expiresAtMs: 50 },
    ];

    // Act
    const actual = activeCallsigns(input, 50);

    // Assert
    should([...actual]).deepEqual(['ada']);
  });

  it('should rotate deterministically, skip active names, and deduplicate candidates', () => {
    // Arrange
    const pool = ['ada', 'bert', 'ada', 'cleo'];
    const claims = [{ callsign: 'bert', ownerId: 'one', claimedAtMs: 0, expiresAtMs: 100 }];

    // Act
    const actual = availableCallsigns(pool, claims, 50, -1);

    // Assert
    should(actual).deepEqual(['cleo', 'ada']);
  });

  it('should return no candidates for an empty pool', () => {
    // Act
    const actual = availableCallsigns([], [], 0, 0);

    // Assert
    should(actual).deepEqual([]);
  });

  it.each([
    { requested: 0, expected: ['ada'] },
    { requested: 2, expected: ['ada', 'bert'] },
    { requested: 100, expected: ['ada', 'bert', 'cleo'] },
  ])('should bound suggestions for requested count $requested', ({ requested, expected }) => {
    // Act
    const actual = suggestCallsigns(['ada', 'bert', 'cleo'], [], 0, requested, 0);

    // Assert
    should(actual).deepEqual(expected);
  });

  it('should resolve an exact id before the newest recent callsign and preserve unknown references', () => {
    // Arrange
    const sessions = [
      { id: 'exact', callsign: 'other', claimedAtMs: 1 },
      { id: 'older', callsign: 'ada', claimedAtMs: 50 },
      { id: 'newer', callsign: 'Ada', claimedAtMs: 80 },
      { id: 'expired', callsign: 'cleo', claimedAtMs: 1 },
    ];

    // Act
    const exact = resolveSessionReference('exact', sessions, 100, 20);
    const recent = resolveSessionReference(' ADA ', sessions, 100, 60);
    const expired = resolveSessionReference('cleo', sessions, 100, 20);

    // Assert
    should(exact).equal('exact');
    should(recent).equal('newer');
    should(expired).equal('cleo');
  });

  it('should publish a frozen, sorted, unique pool without placeholder callsigns', () => {
    // Act
    const valid = isValidCallsignPool(DEFAULT_CALLSIGN_POOL);

    // Assert
    should(valid).be.true();
    should(DEFAULT_CALLSIGN_POOL.length).be.above(9_000);
    should(Object.isFrozen(DEFAULT_CALLSIGN_POOL)).be.true();
    for (const excluded of ['baby', 'babyboy', 'babygirl', 'daemon', 'female', 'male', 'unknown']) {
      should(DEFAULT_CALLSIGN_POOL).not.containEql(excluded);
    }
  });

  it.each([
    { input: [] as readonly string[], expected: false },
    { input: ['Ada'], expected: false },
    { input: ['bert', 'ada'], expected: false },
    { input: ['ada', 'ada'], expected: false },
    { input: ['ada', 'bert'], expected: true },
  ])('should validate a candidate pool structurally', ({ input, expected }) => {
    // Act
    const actual = isValidCallsignPool(input);

    // Assert
    should(actual).equal(expected);
  });
});
