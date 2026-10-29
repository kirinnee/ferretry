import { describe, it } from 'bun:test';
import should from 'should';
import {
  BACKOFF_CEILING_MS,
  backoffHold,
  backoffKey,
  investigationBackoffMs,
  reconcileBackoff,
  recordLook,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-10-28T00:00:00.000Z');
const MINUTE = 60_000;
const BASE = 30 * MINUTE;
const look = { sessionId: 's1', kind: 'sus_subprocess' as const, subject: 'turn:4|cmd:pid:10' };

describe('the investigation backoff ladder', () => {
  it('should wait 30m, then 2h, then 8h, then a day at most', () => {
    // Act
    const rungs = [1, 2, 3, 4, 5, 9].map(count => investigationBackoffMs(count, BASE) / MINUTE);

    // Assert
    should(rungs).deepEqual([30, 120, 480, 1_440, 1_440, 1_440]);
  });

  it('should hold nothing when the owner set no cooldown', () => {
    // Act / Assert
    should(investigationBackoffMs(3, 0)).equal(0);
  });

  it('should hold the same subject for its rung after each look, and climb with each one', () => {
    // Arrange
    const once = recordLook({}, look, NOW, false);
    const twice = recordLook(once, look, NOW + 31 * MINUTE, false);

    // Act / Assert
    should(backoffHold(once, look, NOW + 29 * MINUTE, BASE)).match({ cleared: false, count: 1 });
    should(backoffHold(once, look, NOW + 30 * MINUTE, BASE)).be.undefined();
    should(backoffHold(twice, look, NOW + 31 * MINUTE + 119 * MINUTE, BASE)).match({ count: 2 });
    should(backoffHold(twice, look, NOW + 31 * MINUTE + 120 * MINUTE, BASE)).be.undefined();
  });

  it('should start afresh for a different subject — a new turn or another command', () => {
    // Arrange
    const store = recordLook(recordLook({}, look, NOW, false), look, NOW, false);

    // Act
    const other = { ...look, subject: 'turn:5|cmd:pid:10' };
    const recorded = recordLook(store, other, NOW, false);

    // Assert
    should(backoffHold(store, other, NOW + MINUTE, BASE)).be.undefined();
    should(recorded[backoffKey('s1', 'sus_subprocess')]).match({ subject: other.subject, count: 1 });
  });

  it('should keep a cleared subject left alone until it changes, a day at most', () => {
    // Arrange
    const store = recordLook({}, look, NOW, true);

    // Act / Assert
    should(backoffHold(store, look, NOW + 23 * 60 * MINUTE, BASE)).match({ cleared: true });
    should(backoffHold(store, look, NOW + BACKOFF_CEILING_MS, BASE)).be.undefined();
    should(backoffHold(store, { ...look, kind: 'sus_thinking' }, NOW + MINUTE, BASE)).be.undefined();
  });

  it('should never hold an anomaly that carries no subject', () => {
    // Arrange
    const store = recordLook({}, look, NOW, true);

    // Act / Assert
    should(backoffHold(store, { sessionId: 's1', kind: 'sus_subprocess' }, NOW, BASE)).be.undefined();
    should(recordLook(store, { sessionId: 's2', kind: 'sus_subprocess' }, NOW, true)).equal(store);
  });

  it('should forget ferrets that are gone and looks too old to hold anything', () => {
    // Arrange
    const store = recordLook(recordLook({}, look, NOW, false), { ...look, sessionId: 'gone' }, NOW, false);

    // Act
    const kept = reconcileBackoff(store, new Set(['s1']), NOW);
    const aged = reconcileBackoff(store, new Set(['s1', 'gone']), NOW + 2 * BACKOFF_CEILING_MS + 1);

    // Assert
    should(Object.keys(kept)).deepEqual(['s1|sus_subprocess']);
    should(aged).deepEqual({});
  });
});
