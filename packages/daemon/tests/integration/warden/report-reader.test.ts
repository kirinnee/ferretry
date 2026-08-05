import { afterAll, describe, it } from 'bun:test';
import { chmod, mkdir, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { NodeWardenReportFileSystem, WardenReportReader } from '../../../src/adapters/warden/index.ts';
import {
  buildWardenSpawnProvenance,
  createWardenPaths,
  provenancePath,
  type WardenSelectionProvenance,
  type WardenSpawnFacts,
} from '../../../src/lib/warden/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const facts: WardenSpawnFacts = {
  sessionId: 'wd-1',
  createdAt: '2026-07-30T12:00:00.000Z',
  agent: 'reserve-account',
  harness: 'claude',
  model: 'sample-model-2',
  modelSource: 'harness',
};

const failedOver: WardenSelectionProvenance = {
  policy: 'fallback',
  selection: 'failover',
  configuredFirst: 'primary-account',
  skipped: { 'primary-account': 'at its weekly limit' },
};

/** A throwaway state home with a warden reports directory ready to fill. */
async function reportsHome(label: string): Promise<{ reports: string; reader: WardenReportReader }> {
  const home = await tempDirectory(label);
  const { reports } = createWardenPaths(path.join(home, 'state'));
  await mkdir(reports, { recursive: true });
  return { reports, reader: new WardenReportReader(new NodeWardenReportFileSystem(), reports) };
}

async function writeReport(reports: string, name: string, content: string, mtimeSeconds?: number): Promise<string> {
  const target = path.join(reports, name);
  await writeFile(target, content, 'utf8');
  if (mtimeSeconds !== undefined) await utimes(target, mtimeSeconds, mtimeSeconds);
  return target;
}

describe('NodeWardenReportFileSystem', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should read an empty listing for a state home that has never run a warden', async () => {
    // Arrange
    const home = await tempDirectory('warden-missing');
    const subject = new NodeWardenReportFileSystem();

    // Act
    const files = await subject.listFiles(path.join(home, 'state', 'warden', 'reports'));

    // Assert
    should(files).be.empty();
  });

  it('should atomically write a first report beneath an owner-only reports directory', async () => {
    const home = await tempDirectory('warden-write');
    const report = path.join(home, 'state', 'warden', 'reports', 'sweep.md');
    const subject = new NodeWardenReportFileSystem();

    await subject.writeTextAtomic(report, 'Verdict: LEAVE\n');

    should(await readFile(report, 'utf8')).equal('Verdict: LEAVE\n');
    should((await stat(path.dirname(report))).isDirectory()).be.true();
  });

  it('should remove its temporary file when the final replace fails', async () => {
    const home = await tempDirectory('warden-write-failure');
    const reports = path.join(home, 'state', 'warden', 'reports');
    const target = path.join(reports, 'already-a-directory.md');
    await mkdir(target, { recursive: true });
    const subject = new NodeWardenReportFileSystem();

    await should(subject.writeTextAtomic(target, 'Verdict: LEAVE\n')).be.rejected();

    should((await readdir(reports)).filter(name => name.endsWith('.tmp'))).be.empty();
    should((await stat(target)).isDirectory()).be.true();
  });

  it('should list files with their modification times and skip nested directories', async () => {
    // Arrange
    const { reports } = await reportsHome('warden-list');
    await writeReport(reports, 'a.md', 'Verdict: LEAVE', 1_700_000_000);
    await mkdir(path.join(reports, 'archive'));
    const subject = new NodeWardenReportFileSystem();

    // Act
    const files = await subject.listFiles(reports);

    // Assert
    should(files.map(file => path.basename(file.path))).eql(['a.md']);
    should(files[0]?.mtimeMs).eql(1_700_000_000_000);
  });

  it('should ignore an entry that vanished between the listing and the stat', async () => {
    // Arrange — a dangling symlink stats as missing, exactly like a pruned report.
    const { reports } = await reportsHome('warden-vanished');
    await writeReport(reports, 'a.md', 'Verdict: LEAVE');
    await symlink(path.join(reports, 'gone.md'), path.join(reports, 'dangling.md'));
    const subject = new NodeWardenReportFileSystem();

    // Act
    const files = await subject.listFiles(reports);

    // Assert
    should(files.map(file => path.basename(file.path))).eql(['a.md']);
  });

  it('should keep listing the reports it can stat when one entry is unreadable', async () => {
    // Arrange — a directory with no execute permission cannot be stat-ed
    // through, standing in for any per-entry failure the host throws.
    const { reports } = await reportsHome('warden-unstattable');
    await writeReport(reports, 'a.md', 'Verdict: LEAVE');
    const blocked = path.join(reports, 'blocked');
    await mkdir(blocked);
    await writeFile(path.join(blocked, 'b.md'), 'Verdict: KILL', 'utf8');
    await chmod(blocked, 0o000);
    const subject = new NodeWardenReportFileSystem();

    // Act
    const files = await subject.listFiles(reports);

    // Assert
    await chmod(blocked, 0o700);
    should(files.map(file => path.basename(file.path))).eql(['a.md']);
  });

  it('should read a missing file as undefined rather than failing', async () => {
    // Arrange
    const { reports } = await reportsHome('warden-read-missing');
    const subject = new NodeWardenReportFileSystem();

    // Act / Assert
    should(await subject.readText(path.join(reports, 'nope.md'))).be.undefined();
  });
});

describe('WardenReportReader', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should return no verdicts when no report has been written', async () => {
    // Arrange
    const { reader } = await reportsHome('warden-empty');

    // Act / Assert
    should(await reader.readVerdicts()).be.empty();
  });

  it('should parse the reports on disk newest first', async () => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-verdicts');
    await writeReport(reports, 'old.md', '# Warden report — old\n\nVerdict: LEAVE', 1_700_000_000);
    await writeReport(reports, 'new.md', '# Warden report — new\n\nVerdict: KILL', 1_700_000_600);

    // Act
    const verdicts = await reader.readVerdicts();

    // Assert
    should(verdicts.map(entry => entry.targetSession)).eql(['new', 'old']);
    should(verdicts[0]?.verdict).eql('killed');
  });

  it('should ignore files that are not reports', async () => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-non-reports');
    await writeReport(reports, 'a.md', '# Warden report — a\n\nVerdict: LEAVE');
    await writeReport(reports, 'notes.txt', '# Warden report — b\n\nVerdict: KILL');

    // Act
    const verdicts = await reader.readVerdicts();

    // Assert
    should(verdicts.map(entry => entry.targetSession)).eql(['a']);
  });

  it('should refuse an empty report rather than presenting an incomplete history as quiet', async () => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-blank');
    await writeReport(reports, 'blank.md', '   \n');
    await writeReport(reports, 'real.md', '# Warden report — real\n\nVerdict: LEAVE');

    // Act / Assert
    await should(reader.readVerdicts()).be.rejectedWith('a Warden report could not be read');
  });

  it('should honour the requested row limit', async () => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-limit');
    await writeReport(reports, 'a.md', '# Warden report — a\n\nVerdict: LEAVE', 1_700_000_000);
    await writeReport(reports, 'b.md', '# Warden report — b\n\nVerdict: LEAVE', 1_700_000_600);

    // Act
    const verdicts = await reader.readVerdicts(1);

    // Assert
    should(verdicts.map(entry => entry.targetSession)).eql(['b']);
  });

  it('should attach the spawn facts recorded beside a report', async () => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-provenance');
    const report = await writeReport(reports, 'a.md', '# Warden report — a\n\nVerdict: LEAVE');
    const provenance = buildWardenSpawnProvenance(facts, failedOver, 'a');
    await writeFile(provenancePath(report), JSON.stringify(provenance), 'utf8');

    // Act
    const verdicts = await reader.readVerdicts();

    // Assert
    should(verdicts[0]?.spawn?.agent).eql('reserve-account');
    should(verdicts[0]?.spawn?.failoverReason).eql('at its weekly limit');
  });

  it.each([
    { label: 'unreadable JSON', payload: '{ not json' },
    { label: 'a payload that fails the schema', payload: '{"v":1,"agent":""}' },
  ])('should treat $label in a sidecar as no provenance at all', async ({ payload }) => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-corrupt');
    const report = await writeReport(reports, 'a.md', '# Warden report — a\n\nVerdict: LEAVE');
    await writeFile(provenancePath(report), payload, 'utf8');

    // Act
    const verdicts = await reader.readVerdicts();

    // Assert
    should(verdicts).have.length(1);
    should(verdicts[0]?.spawn).be.undefined();
  });

  it('should render a single report with its provenance block on top', async () => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-render');
    const report = await writeReport(reports, 'a.md', '# Warden report — a\n\nVerdict: LEAVE');
    await writeFile(provenancePath(report), JSON.stringify(buildWardenSpawnProvenance(facts, failedOver)), 'utf8');

    // Act
    const rendered = await reader.readReport(report);

    // Assert
    should(rendered).startWith('## Who ran this check');
    should(rendered).containEql('- Account: **`reserve-account`**');
    should(rendered).containEql('# Warden report — a');
  });

  it('should render a report that has no sidecar unchanged', async () => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-render-plain');
    const report = await writeReport(reports, 'a.md', 'body');

    // Act / Assert
    should(await reader.readReport(report)).eql('body');
  });

  it('should return nothing for a report that does not exist', async () => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-render-missing');

    // Act / Assert
    should(await reader.readReport(path.join(reports, 'nope.md'))).be.undefined();
  });

  it('should read only a direct Markdown report inside this daemon’s evidence directory', async () => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-read-at');
    const report = await writeReport(reports, 'a.md', 'body');

    // Act / Assert — the browser may name a row’s path, never an arbitrary file.
    should(await reader.readReportAt(report)).eql('body');
    should(await reader.readReportAt(path.join(reports, 'nested', 'a.md'))).be.undefined();
    should(await reader.readReportAt(path.join(reports, 'a.txt'))).be.undefined();
  });

  it('should read no provenance when no sidecar was written', async () => {
    // Arrange
    const { reports, reader } = await reportsHome('warden-no-sidecar');
    const report = await writeReport(reports, 'a.md', 'body');

    // Act / Assert
    should(await reader.readProvenance(report)).be.undefined();
  });
});
