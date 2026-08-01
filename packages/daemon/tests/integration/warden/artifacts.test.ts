import { afterAll, describe, it } from 'bun:test';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import {
  FileWardenArtifacts,
  NodeWardenReportFileSystem,
  REPORT_HEAD_LINES,
  WardenReportReader,
} from '../../../src/adapters/warden/index.ts';
import {
  buildWardenSpawnProvenance,
  createWardenPaths,
  provenancePath,
  type WardenSelectionProvenance,
  type WardenSpawnFacts,
} from '../../../src/lib/warden/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const FACTS: WardenSpawnFacts = {
  sessionId: 'wd-1',
  createdAt: '2026-07-31T12:00:00.000Z',
  agent: 'reserve-account',
  harness: 'claude',
  model: 'sample-model-2',
  modelSource: 'harness',
};

const SELECTION: WardenSelectionProvenance = {
  policy: 'fallback',
  selection: 'preferred',
  configuredFirst: 'reserve-account',
  skipped: {},
};

/** A throwaway state home whose reports directory does not exist yet. */
async function artifactsHome(label: string): Promise<{ reports: string; subject: FileWardenArtifacts }> {
  const home = await tempDirectory(label);
  const { reports } = createWardenPaths(path.join(home, 'state'));
  const files = new NodeWardenReportFileSystem();
  return { reports, subject: new FileWardenArtifacts(files, new WardenReportReader(files, reports), reports) };
}

/** Writes a report, back-dating it so newest-first ordering is deterministic. */
async function report(reports: string, name: string, content: string, ageMinutes: number): Promise<string> {
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const file = path.join(reports, name);
  await writeFile(file, content, 'utf8');
  const when = new Date(Date.parse('2026-07-31T12:00:00.000Z') - ageMinutes * 60_000);
  await utimes(file, when, when);
  return file;
}

afterAll(cleanupTempDirectories);

describe('where a warden is told to write', () => {
  it('should derive a fleet-sweep path from the instant alone', async () => {
    // Arrange
    const { reports, subject } = await artifactsHome('warden-artifacts-sweep-path');

    // Act
    const actual = subject.reportPath('2026-07-31T12:00:00.000Z');

    // Assert
    should(actual).equal(path.join(reports, '2026-07-31T12-00-00-000Z.md'));
  });

  it('should keep two assigned wardens of the same instant apart by target', async () => {
    // Arrange
    const { subject } = await artifactsHome('warden-artifacts-assigned-path');

    // Act
    const first = subject.reportPath('2026-07-31T12:00:00.000Z', 's1');
    const second = subject.reportPath('2026-07-31T12:00:00.000Z', 's2');

    // Assert
    should(first).not.equal(second);
    should(first).endWith('-s1.md');
  });
});

describe('recording who ran the check', () => {
  it('should write the sidecar beside the report the warden was told to write', async () => {
    // Arrange
    const { subject } = await artifactsHome('warden-artifacts-provenance');
    const reportPath = subject.reportPath('2026-07-31T12:00:00.000Z');

    // Act
    await subject.writeProvenance(reportPath, buildWardenSpawnProvenance(FACTS, SELECTION));

    // Assert
    const raw = JSON.parse(await readFile(provenancePath(reportPath), 'utf8'));
    should(raw.wardenSessionId).equal('wd-1');
  });

  it('should create the reports directory owner-only on the first sweep of a state home', async () => {
    // Arrange
    const { reports, subject } = await artifactsHome('warden-artifacts-mode');

    // Act
    await subject.writeProvenance(
      subject.reportPath('2026-07-31T12:00:00.000Z'),
      buildWardenSpawnProvenance(FACTS, SELECTION),
    );

    // Assert
    should((await stat(reports)).mode & 0o777).equal(0o700);
  });

  it('should never write the provenance into the report itself', async () => {
    // Arrange: the verdict parser must see the model's own words only.
    const { reports, subject } = await artifactsHome('warden-artifacts-separate');
    const reportPath = await report(reports, '2026-07-31T12-00-00-000Z.md', 'Verdict: LEAVE\n', 0);

    // Act
    await subject.writeProvenance(reportPath, buildWardenSpawnProvenance(FACTS, SELECTION));

    // Assert
    should(await readFile(reportPath, 'utf8')).equal('Verdict: LEAVE\n');
  });
});

describe('reading a report back', () => {
  it('should prepend the provenance block at read time', async () => {
    // Arrange
    const { reports, subject } = await artifactsHome('warden-artifacts-merged');
    const reportPath = await report(reports, '2026-07-31T12-00-00-000Z.md', 'Verdict: LEAVE\n', 0);
    await subject.writeProvenance(reportPath, buildWardenSpawnProvenance(FACTS, SELECTION));

    // Act
    const actual = await subject.readReport(reportPath);

    // Assert
    should(actual).startWith('## Who ran this check');
    should(actual).containEql('Verdict: LEAVE');
  });

  it('should answer with nothing for a report that was never written', async () => {
    // Arrange
    const { subject } = await artifactsHome('warden-artifacts-missing');

    // Act / Assert
    should(await subject.readReport(subject.reportPath('2026-07-31T12:00:00.000Z'))).be.undefined();
  });
});

describe('the newest report', () => {
  it('should be nothing at all on a state home where no warden has ever run', async () => {
    // Arrange
    const { subject } = await artifactsHome('warden-artifacts-latest-empty');

    // Act / Assert
    should(await subject.latest()).be.undefined();
  });

  it('should be identified by filename rather than by a path inside the state home', async () => {
    // Arrange: the value is served on a route a warden-scoped token can read.
    const { reports, subject } = await artifactsHome('warden-artifacts-latest-id');
    await report(reports, 'older.md', 'Verdict: KILL\n', 60);
    await report(reports, 'newest.md', 'Verdict: LEAVE\n', 0);

    // Act
    const actual = await subject.latest();

    // Assert
    should(actual?.reportId).equal('newest.md');
    should(actual?.reportId).not.containEql(path.sep);
  });

  it('should be the newest by modification time, matching how the verdict list orders them', async () => {
    // Arrange: a filename sort would disagree the moment a report was rewritten.
    const { reports, subject } = await artifactsHome('warden-artifacts-latest-order');
    await report(reports, 'zzz-old.md', 'Verdict: KILL\n', 60);
    await report(reports, 'aaa-new.md', 'Verdict: LEAVE\n', 0);

    // Act / Assert
    should((await subject.latest())?.reportId).equal('aaa-new.md');
  });

  it('should show only the leading lines an operator glancing at the status needs', async () => {
    // Arrange
    const { reports, subject } = await artifactsHome('warden-artifacts-latest-head');
    const body = Array.from({ length: 40 }, (_unused, line) => `line ${line}`).join('\n');
    await report(reports, 'long.md', body, 0);

    // Act
    const actual = await subject.latest();

    // Assert
    should(actual?.head.split('\n')).have.length(REPORT_HEAD_LINES);
    should(actual?.head).startWith('line 0');
  });

  it('should ignore a sidecar, which is not a report', async () => {
    // Arrange
    const { reports, subject } = await artifactsHome('warden-artifacts-latest-sidecar');
    await report(reports, 'r.md', 'Verdict: LEAVE\n', 10);
    await report(reports, 'r.md.meta.json', '{}', 0);

    // Act / Assert
    should((await subject.latest())?.reportId).equal('r.md');
  });

  it('should never mistake a nested directory for the newest report', async () => {
    // Arrange: a `.md` directory sorts like a report and would otherwise blank the status surface.
    const { reports, subject } = await artifactsHome('warden-artifacts-latest-directory');
    await report(reports, 'real.md', 'Verdict: LEAVE\n', 60);
    await mkdir(path.join(reports, 'zzz-newer.md'), { recursive: true });

    // Act / Assert
    should((await subject.latest())?.reportId).equal('real.md');
  });
});
