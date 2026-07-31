import { describe, it } from 'bun:test';
import should from 'should';
import {
  attachSpawnProvenance,
  buildWardenSpawnProvenance,
  createWardenPaths,
  mergeWardenReportProvenance,
  MINIMUM_REPORTS_READ,
  reportsWorthReading,
  verdictSpawn,
  type WardenFileInfo,
  type WardenSelectionProvenance,
  type WardenSpawnFacts,
  type WardenVerdict,
} from '../../../src/lib/warden/index.ts';

const facts: WardenSpawnFacts = {
  sessionId: 'wd-1',
  createdAt: '2026-07-30T12:00:00.000Z',
  agent: 'reserve-account',
  harness: 'claude',
  model: 'sample-model-2',
  modelSource: 'harness',
};

const preferred: WardenSelectionProvenance = {
  policy: 'fallback',
  selection: 'preferred',
  configuredFirst: 'reserve-account',
  skipped: {},
};

const failedOver: WardenSelectionProvenance = {
  policy: 'fallback',
  selection: 'failover',
  configuredFirst: 'primary-account',
  skipped: { 'primary-account': 'at its weekly limit' },
};

const file = (path: string, mtimeMs: number): WardenFileInfo => ({ path, mtimeMs });

const verdict = (reportPath: string): WardenVerdict => ({
  at: '2026-07-30T12:00:00.000Z',
  verdict: 'cleared',
  reportPath,
});

describe('warden paths', () => {
  it('should keep reports under a warden directory in the state home', () => {
    // Arrange / Act
    const paths = createWardenPaths('/state');

    // Assert
    should(paths).eql({ root: '/state/warden', reports: '/state/warden/reports' });
  });
});

describe('choosing reports to read', () => {
  it('should read only markdown, newest first', () => {
    // Arrange
    const files = [file('/r/a.md', 10), file('/r/notes.txt', 99), file('/r/b.md', 20)];

    // Act
    const chosen = reportsWorthReading(files, 5);

    // Assert
    should(chosen.map(entry => entry.path)).eql(['/r/b.md', '/r/a.md']);
  });

  it('should order same-instant reports by path', () => {
    // Arrange
    const files = [file('/r/b.md', 10), file('/r/a.md', 10)];

    // Act / Assert
    should(reportsWorthReading(files, 5).map(entry => entry.path)).eql(['/r/a.md', '/r/b.md']);
  });

  it('should open more reports than the row limit so one file cannot hide the rest', () => {
    // Arrange
    const files = Array.from({ length: 200 }, (_unused, index) => file(`/r/${index}.md`, index));

    // Act / Assert
    should(reportsWorthReading(files, 5)).have.length(MINIMUM_REPORTS_READ);
    should(reportsWorthReading(files, 60)).have.length(120);
  });

  it('should read nothing for a non-positive limit', () => {
    // Arrange / Act / Assert
    should(reportsWorthReading([file('/r/a.md', 1)], 0)).be.empty();
  });

  it('should not mutate the caller listing', () => {
    // Arrange
    const files = [file('/r/a.md', 10), file('/r/b.md', 20)];

    // Act
    reportsWorthReading(files, 5);

    // Assert
    should(files.map(entry => entry.path)).eql(['/r/a.md', '/r/b.md']);
  });
});

describe('report provenance merging', () => {
  it('should prepend the provenance block to the report body', () => {
    // Arrange
    const provenance = buildWardenSpawnProvenance(facts, preferred);

    // Act
    const merged = mergeWardenReportProvenance('# Warden report — s1\n', provenance);

    // Assert
    should(merged.startsWith('## Who ran this check')).be.true();
    should(merged).containEql('# Warden report — s1');
  });

  it('should leave a report alone when no provenance was recorded', () => {
    // Arrange / Act / Assert
    should(mergeWardenReportProvenance('body')).eql('body');
  });
});

describe('verdict spawn facts', () => {
  it('should explain why a failover happened', () => {
    // Arrange / Act
    const spawn = verdictSpawn(buildWardenSpawnProvenance(facts, failedOver));

    // Assert
    should(spawn.failoverReason).eql('at its weekly limit');
  });

  it('should carry no failover reason for a preferred launch', () => {
    // Arrange / Act
    const spawn = verdictSpawn(buildWardenSpawnProvenance(facts, preferred));

    // Assert
    should(spawn.failoverReason).be.undefined();
  });

  it('should tolerate a failover the daemon recorded no reason for', () => {
    // Arrange / Act
    const spawn = verdictSpawn(buildWardenSpawnProvenance(facts, { ...failedOver, skipped: {} }));

    // Assert
    should(spawn.failoverReason).be.undefined();
  });

  it('should attach provenance only to the verdicts whose report has some', () => {
    // Arrange
    const provenance = new Map([['/r/a.md', buildWardenSpawnProvenance(facts, preferred)]]);

    // Act
    const attached = attachSpawnProvenance([verdict('/r/a.md'), verdict('/r/b.md')], provenance);

    // Assert
    should(attached[0]?.spawn?.agent).eql('reserve-account');
    should(attached[1]?.spawn).be.undefined();
  });
});
