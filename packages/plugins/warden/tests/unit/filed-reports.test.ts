import { describe, it } from 'bun:test';
import should from 'should';
import { FILED_REPORTS_REMEMBERED, onceFiled } from '../../daemon/lib/filed-reports.ts';
import type { WardenArtifacts } from '../../daemon/lib/sweep.ts';

/**
 * The sweep reads every finished investigation's report for a day, and reading is what files it. A filed report must cost
 * one read, not two file reads on every sweep.
 */

/** Artifacts whose reports are filed on demand, counting each read that reaches the disk. */
function disk(filed: Set<string>) {
  const reads: string[] = [];
  const artifacts: WardenArtifacts = {
    writeProvenance: async () => undefined,
    readReport: async path => {
      reads.push(path);
      return filed.has(path) ? `# ${path}` : undefined;
    },
    latest: async () => ({ reportId: 'r', head: 'h' }),
    reportPath: (at, targetId) => `/reports/${at}-${targetId ?? ''}.md`,
  };
  return { reads, artifacts };
}

describe('the artifacts a sweep reads reports through', () => {
  it('should read a filed report once and answer the same text on every later sweep', async () => {
    // Arrange
    const { reads, artifacts } = disk(new Set(['a.md', 'b.md']));
    const subject = onceFiled(artifacts);

    // Act
    const sweeps = [];
    for (let sweep = 0; sweep < 3; sweep += 1)
      sweeps.push([await subject.readReport('a.md'), await subject.readReport('b.md')]);

    // Assert
    should(reads).deepEqual(['a.md', 'b.md']);
    should(sweeps.every(sweep => sweep[0] === '# a.md' && sweep[1] === '# b.md')).be.true();
  });

  it('should keep reading a report that is not there yet, until it lands', async () => {
    // Arrange
    const filed = new Set<string>();
    const { reads, artifacts } = disk(filed);
    const subject = onceFiled(artifacts);
    const first = await subject.readReport('late.md');
    filed.add('late.md');

    // Act
    const second = await subject.readReport('late.md');
    const third = await subject.readReport('late.md');

    // Assert
    should(first).be.undefined();
    should([second, third]).deepEqual(['# late.md', '# late.md']);
    should(reads).deepEqual(['late.md', 'late.md']);
  });

  it('should forget the oldest filed report once it holds more than it keeps', async () => {
    // Arrange
    const paths = Array.from({ length: FILED_REPORTS_REMEMBERED + 1 }, (_, index) => `r${String(index)}.md`);
    const { reads, artifacts } = disk(new Set(paths));
    const subject = onceFiled(artifacts);
    for (const path of paths) await subject.readReport(path);
    const readsBefore = reads.length;

    // Act
    await subject.readReport(paths.at(-1) as string);
    await subject.readReport(paths[0] as string);

    // Assert: the newest is still held; the oldest was dropped, so it reads again.
    should(reads.length).equal(readsBefore + 1);
    should(reads.at(-1)).equal('r0.md');
  });

  it('should hand every other call through to the artifacts it wraps', async () => {
    // Arrange
    const { artifacts } = disk(new Set());
    const subject = onceFiled(artifacts);

    // Act
    const latest = await subject.latest();
    const path = subject.reportPath('2026-11-25', 'w1');
    await subject.writeProvenance('a.md', {} as never);

    // Assert
    should(latest).deepEqual({ reportId: 'r', head: 'h' });
    should(path).equal('/reports/2026-11-25-w1.md');
  });
});
