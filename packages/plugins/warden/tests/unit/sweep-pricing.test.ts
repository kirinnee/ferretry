import { describe, it } from 'bun:test';
import should from 'should';
import type { WardenInvestigationRecord } from '../../daemon/lib/triage.ts';
import { at, enabled, harness } from './sweep-harness.ts';

/**
 * What one sweep spends on the investigations it keeps for a day: one keyed price per UNPRICED record. v4 re-read and
 * re-priced the whole analytics history once per unpriced investigation (33 × 11.5k rows, ~12 s of main thread).
 */

const COUNT = 40;

const records = (): WardenInvestigationRecord[] =>
  Array.from({ length: COUNT }, (_, index) => ({
    id: `w${String(index)}`,
    scope: 'fleet' as const,
    origin: 'sweep' as const,
    startedAt: at(-60),
    finishedAt: at(-30),
    reportPath: `reports/w${String(index)}.md`,
  }));

describe('the sweep over a day of finished investigations', () => {
  it('should price every unpriced investigation with one keyed ask each, and never ask again for a priced one', async () => {
    // Arrange
    const asked: string[] = [];
    const subject = harness({
      config: enabled(),
      state: { investigations: records() },
      cost: async id => {
        asked.push(id);
        return 0.25;
      },
    });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    const priced = (subject.state().investigations ?? []).filter(record => record.costUsd === 0.25);
    should(priced).have.length(COUNT);
    should(asked).have.length(COUNT);
    should(subject.state().costAverage).deepEqual({ count: COUNT, totalUsd: COUNT * 0.25 });
  });

  it('should ask again next sweep for an investigation that is not priced yet', async () => {
    // Arrange
    const asked: string[] = [];
    const subject = harness({
      config: enabled(),
      state: { investigations: records() },
      cost: async id => {
        asked.push(id);
        return undefined;
      },
    });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(asked).have.length(COUNT * 2);
    should((subject.state().investigations ?? []).some(record => record.costUsd !== undefined)).be.false();
  });
});
