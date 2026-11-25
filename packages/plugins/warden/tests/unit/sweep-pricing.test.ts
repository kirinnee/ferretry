import { describe, it } from 'bun:test';
import should from 'should';
import type { WardenInvestigationRecord } from '../../daemon/lib/triage.ts';
import { at, enabled, harness } from './sweep-harness.ts';

/**
 * What one sweep spends on the investigations it keeps for a day: one keyed price per UNPRICED record, and one read of a
 * report only until it is filed. v4 re-read and re-priced the whole analytics history once per unpriced investigation
 * (33 × 11.5k rows, ~12 s of main thread every sweep).
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

/** A reports map that counts every read of it, and files a report only once `filed` holds its path. */
function countedReports(filed: ReadonlySet<string>) {
  const reads: string[] = [];
  const map = new Proxy({} as Record<string, string | undefined>, {
    get: (_target, path) => {
      reads.push(String(path));
      return filed.has(String(path)) ? '# report' : undefined;
    },
  });
  return { reads, map };
}

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

  it('should read a report once it is filed, then leave it alone on every later sweep', async () => {
    // Arrange: every report is filed on the first read.
    const reports = countedReports(new Set(records().map(record => record.reportPath)));
    const subject = harness({ config: enabled(), state: { investigations: records() }, reports: reports.map });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(reports.reads).have.length(COUNT);
  });

  it('should keep reading a report that is not there yet, until it lands', async () => {
    // Arrange
    const filed = new Set<string>();
    const reports = countedReports(filed);
    const subject = harness({ config: enabled(), state: { investigations: records() }, reports: reports.map });
    await subject.service.run({ force: false });
    filed.add('reports/w0.md');

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert: 40 reads on the first sweep, 40 on the second (w0 files), then 39 on the third.
    should(reports.reads).have.length(COUNT + COUNT + (COUNT - 1));
  });
});
