import { describe, it } from 'bun:test';
import type { PassiveUsageRecord } from '@ferretry/fleet';
import should from 'should';
import {
  dueCredentials,
  EMPTY_FLEET_READING,
  nextDueAt,
  readingDueAt,
  readingFor,
  withObserved,
  withPassive,
  withPassiveUnknown,
} from '../../../src/lib/fleet-reading/model.ts';

const MINUTE = 60_000;
const NOW = 1_786_000_000_000;
const passive = (at: number): PassiveUsageRecord => ({
  version: 1,
  source: 'claude-statusline',
  at,
  fiveHour: { usedPercent: 12 },
});

describe('the fleet reading model', () => {
  it('should keep what it knows of credentials still named, start new ones unknown, and forget the rest', () => {
    // Arrange
    const known = withPassive(readingFor(EMPTY_FLEET_READING, ['work', 'gone']), 'work', passive(NOW));

    // Act
    const actual = readingFor(known, ['work', 'new']);

    // Assert
    should([...actual]).deepEqual([
      ['work', { passive: passive(NOW), passiveKnown: true }],
      ['new', { passiveKnown: false }],
    ]);
  });

  it('should take a finished passive read as current — a reading, or none — and a failed one as not', () => {
    // Arrange
    const state = withPassive(readingFor(EMPTY_FLEET_READING, ['work']), 'work', passive(NOW));

    // Act
    const none = withPassive(state, 'work', undefined);
    const failed = withPassiveUnknown(state, 'work');

    // Assert
    should(none.get('work')).deepEqual({ passiveKnown: true });
    should(failed.get('work')).deepEqual({ passive: passive(NOW), passiveKnown: false });
  });

  it('should leave a credential it does not hold untouched by any update', () => {
    // Arrange
    const state = readingFor(EMPTY_FLEET_READING, ['work']);

    // Act / Assert
    should(withPassive(state, 'other', passive(NOW))).equal(state);
    should(withPassiveUnknown(state, 'other')).equal(state);
    should([...withObserved(state, ['other'], NOW)]).deepEqual([...state]);
  });

  it('should hold the active read off for one interval after a current measured passive reading', () => {
    // Arrange
    const fresh = withPassive(readingFor(EMPTY_FLEET_READING, ['work']), 'work', passive(NOW));
    const stale = withPassiveUnknown(fresh, 'work');

    // Act / Assert — a reading that is not current holds nothing off.
    should(readingDueAt(fresh.get('work') ?? { passiveKnown: false }, MINUTE)).equal(NOW + MINUTE);
    should(readingDueAt(stale.get('work') ?? { passiveKnown: true }, MINUTE)).equal(Number.NEGATIVE_INFINITY);
  });

  it('should name the credentials due now, and the earliest instant the next one is', () => {
    // Arrange — a session writes passive readings for `busy`; `idle` was observed a while ago; `new` never.
    let state = readingFor(EMPTY_FLEET_READING, ['busy', 'idle', 'new']);
    state = withPassive(state, 'busy', passive(NOW - 1_000));
    state = withObserved(state, ['idle'], NOW - 30_000);

    // Act
    const dueNow = dueCredentials(state, NOW, MINUTE);
    const afterNew = withObserved(state, ['new'], NOW);
    const next = nextDueAt(afterNew, MINUTE);

    // Assert
    should(dueNow).deepEqual(['new']);
    should(next).equal(NOW - 30_000 + MINUTE);
    should(dueCredentials(afterNew, NOW + MINUTE, MINUTE)).deepEqual(['busy', 'idle', 'new']);
  });

  it('should have no next instant when there is nothing to read', () => {
    // Act / Assert
    should(nextDueAt(EMPTY_FLEET_READING, MINUTE)).be.undefined();
  });
});
