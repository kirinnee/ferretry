import { describe, expect, test } from 'bun:test';
import { FileWardenArtifacts } from '../../daemon/adapters/artifacts.ts';
import { WardenReportReader } from '../../daemon/adapters/report-reader.ts';
import {
  buildWardenSpawnProvenance,
  provenancePath,
  type WardenFileInfo,
  type WardenReportFileSystem,
} from '../../daemon/lib/index.ts';

const DIR = '/state/warden/reports';
const spawn = buildWardenSpawnProvenance(
  {
    sessionId: 'wd-1',
    createdAt: '2026-11-06T09:00:00.000Z',
    agent: 'reserve',
    harness: 'claude',
    model: 'sample-model',
    modelSource: 'harness',
  },
  { policy: 'fallback', selection: 'preferred', configuredFirst: 'reserve', skipped: {} },
);

/** An in-memory report folder; a path in `unreadable` throws when read. */
function folder(texts: Record<string, string>, mtimes: Record<string, number> = {}, unreadable: string[] = []) {
  const written = new Map<string, string>();
  const files: WardenReportFileSystem = {
    listFiles: async directory =>
      Object.keys(texts)
        .filter(path => path.startsWith(`${directory}/`) && !path.includes('.meta.'))
        .map((path): WardenFileInfo => ({ path, mtimeMs: mtimes[path] ?? 1 })),
    readText: async path => {
      if (unreadable.includes(path)) throw new Error('io fault');
      return written.get(path) ?? texts[path];
    },
    writeTextAtomic: async (path, text) => {
      written.set(path, text);
    },
  };
  return { files, written };
}

describe('the warden report reader', () => {
  test('a sidecar that is valid is read back, one that is missing, unreadable, not JSON or fails its schema is no provenance', async () => {
    const report = `${DIR}/a.md`;
    const readerOf = (sidecar: string | undefined, fault = false) =>
      new WardenReportReader(
        folder(
          sidecar === undefined ? {} : { [provenancePath(report)]: sidecar },
          {},
          fault ? [provenancePath(report)] : [],
        ).files,
        DIR,
      );

    expect(await readerOf(JSON.stringify(spawn)).readProvenance(report)).toEqual(spawn);
    expect(await readerOf(undefined).readProvenance(report)).toBeUndefined();
    expect(await readerOf('x', true).readProvenance(report)).toBeUndefined();
    expect(await readerOf('{not json').readProvenance(report)).toBeUndefined();
    expect(await readerOf(JSON.stringify({ v: 1 })).readProvenance(report)).toBeUndefined();
  });

  test('a report is read with its provenance block on top, and a missing one as nothing', async () => {
    const report = `${DIR}/a.md`;
    const reader = new WardenReportReader(
      folder({ [report]: 'VERDICT: cleared\n\nfine\n', [provenancePath(report)]: JSON.stringify(spawn) }).files,
      DIR,
    );

    const text = await reader.readReport(report);

    expect(text).toContain('fine');
    expect(text).toContain('sample-model');
    expect(await reader.readReport(`${DIR}/absent.md`)).toBeUndefined();
  });

  test('verdicts carry the spawn facts of the reports that have a sidecar', async () => {
    const withSidecar = `${DIR}/2026-11-06T10-00-00-000Z.md`;
    const reader = new WardenReportReader(
      folder(
        { [withSidecar]: 'VERDICT: cleared\n\nfine\n', [provenancePath(withSidecar)]: JSON.stringify(spawn) },
        { [withSidecar]: 2 },
      ).files,
      DIR,
    );

    const verdicts = await reader.readVerdicts();

    expect(verdicts.map(verdict => verdict.reportPath)).toEqual([withSidecar]);
    expect(verdicts[0]?.spawn?.wardenSessionId).toBe('wd-1');
  });

  test('an empty report fails the list like an unreadable one, so the index reads unavailable, not quietly short', async () => {
    const empty = `${DIR}/2026-11-06T09-00-00-000Z.md`;
    const reader = new WardenReportReader(folder({ [empty]: '  \n' }).files, DIR);

    await expect(reader.readVerdicts()).rejects.toThrow('a Warden report could not be read');
  });

  test('a report that cannot be read fails the whole list rather than reading as a quiet history', async () => {
    const bad = `${DIR}/bad.md`;
    const reader = new WardenReportReader(folder({ [bad]: 'x' }, {}, [bad]).files, DIR);

    await expect(reader.readVerdicts()).rejects.toThrow('a Warden report could not be read');
  });

  test('only a markdown file directly inside the reports folder is served by path', async () => {
    const report = `${DIR}/a.md`;
    const reader = new WardenReportReader(
      folder({ [report]: 'VERDICT: cleared\n\nfine\n', '/etc/x.md': 'no' }).files,
      DIR,
    );

    expect(await reader.readReportAt(report)).toContain('fine');
    expect(await reader.readReportAt(`${DIR}/../x.md`)).toBeUndefined();
    expect(await reader.readReportAt(`${DIR}/a.txt`)).toBeUndefined();
  });
});

describe('audit A fix 7: a scope is applied before the limit', () => {
  /** One fleet report: `foreign` sections about strangers, THEN the caller's own. */
  const fleetReport = (foreign: number) =>
    [
      '# Warden sweep (2026-11-06T09:00:00.000Z)',
      ...Array.from({ length: foreign }, (_, index) => `## Anomaly: other-${index}\nVERDICT: LEAVE`),
      '## Anomaly: mine-1\nVERDICT: NEEDS_HUMAN',
    ].join('\n\n');
  const report = `${DIR}/2026-11-06T09-00-00-000Z.md`;
  const mine = { mayRead: (id: string) => id === 'mine-1' };

  test('foreign sections ahead of the caller’s own cannot evict its row from the limit', async () => {
    const reader = new WardenReportReader(folder({ [report]: fleetReport(30) }).files, DIR);

    const rows = await reader.readVerdicts(20, mine);

    expect(rows.map(row => row.targetSession)).toEqual(['mine-1']);
    expect(rows[0]?.verdict).toBe('needs_human');
  });

  test('the limit still counts what the caller may read, and the owner’s list is cut as before', async () => {
    const reader = new WardenReportReader(folder({ [report]: fleetReport(30) }).files, DIR);

    const everyone = await reader.readVerdicts(20, { mayRead: () => true });
    const owner = await reader.readVerdicts(20);

    expect(everyone).toHaveLength(20);
    expect(owner).toHaveLength(20);
    expect(owner.map(row => row.targetSession)).not.toContain('mine-1');
  });
});

/**
 * Audit A fix 8 (addendum 2): the parser splits a fleet report on `## ` headings only, so a line that LOOKS like a heading
 * (`###`, `#`, an indented one) stays inside the section above it, and whatever it says would label that section's row.
 * For a scoped reader (a ferret) such a row is `unknown`, never a value taken from the text after the line. The owner's
 * read keeps the parser's reading.
 */
describe('audit A fix 8: a heading the parser did not split on cannot relabel a ferret’s own row', () => {
  const report = `${DIR}/2026-11-06T09-00-00-000Z.md`;
  const mine = { mayRead: (id: string) => id === 'mine-1' };
  const MALFORMED = ['### Anomaly: other-1', '# Anomaly: other-1', '   ### Anomaly: other-1', '#### anything'] as const;
  const read = async (text: string, scope?: { mayRead: (id: string) => boolean }) =>
    await new WardenReportReader(folder({ [report]: text }).files, DIR).readVerdicts(20, scope);

  test('rv7’s repro: an own section with no verdict stays unknown when a foreign heading follows it', async () => {
    const plain = await read('## Anomaly: mine-1\nNo conclusion.\n', mine);
    expect(plain[0]).toMatchObject({ targetSession: 'mine-1', verdict: 'unknown' });
    for (const heading of MALFORMED) {
      const text = `## Anomaly: mine-1\nNo conclusion.\n${heading}\nVERDICT: NEEDS_HUMAN\n`;
      const rows = await read(text, mine);
      expect([heading, rows.map(row => [row.targetSession, row.verdict])]).toEqual([heading, [['mine-1', 'unknown']]]);
      expect(rows[0]).not.toHaveProperty('explicitNeedsHuman');
      expect(rows[0]).not.toHaveProperty('anomalyKind');
    }
  });

  test('text after the heading never labels the row, whatever it says or wherever the line sits', async () => {
    const text = [
      '## Anomaly: mine-1',
      'VERDICT: LEAVE',
      '**Reported reason:** stalled',
      '### Appendix',
      'VERDICT: NEEDS_HUMAN',
    ].join('\n');
    const rows = await read(text, mine);
    expect(rows.map(row => row.verdict)).toEqual(['unknown']);
  });

  test('the owner’s read is unchanged: the parser’s own reading stands', async () => {
    const text = '## Anomaly: mine-1\nNo conclusion.\n### Anomaly: other-1\nVERDICT: NEEDS_HUMAN\n';
    const owner = await read(text);
    expect(owner[0]).toMatchObject({ targetSession: 'mine-1', verdict: 'needs_human' });
  });

  test('a section with no stray heading is read as before, for a ferret too', async () => {
    const rows = await read('## Anomaly: mine-1\nVERDICT: NEEDS_HUMAN\n\n## Anomaly: other-1\nVERDICT: LEAVE\n', mine);
    expect(rows.map(row => [row.targetSession, row.verdict])).toEqual([['mine-1', 'needs_human']]);
  });
});

describe('the warden report artifacts', () => {
  test('a sidecar is written pretty-printed beside the report and read back with it', async () => {
    const { files, written } = folder({});
    const artifacts = new FileWardenArtifacts(files, new WardenReportReader(files, DIR), DIR);
    const path = artifacts.reportPath('2026-11-06T09:00:00.000Z', 'f1');

    await artifacts.writeProvenance(path, spawn);

    expect(written.get(provenancePath(path))).toBe(`${JSON.stringify(spawn, null, 2)}\n`);
    expect(await artifacts.readReport(path)).toBeUndefined();
  });

  test('the latest report is named by its filename with its first lines, newest by modification time', async () => {
    const older = `${DIR}/2026-11-06T09-00-00-000Z.md`;
    const newer = `${DIR}/2026-11-06T08-00-00-000Z.md`;
    const long = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    const { files } = folder({ [older]: 'old', [newer]: long }, { [older]: 1, [newer]: 2 });
    const artifacts = new FileWardenArtifacts(files, new WardenReportReader(files, DIR), DIR);

    const latest = await artifacts.latest();

    expect(latest?.reportId).toBe('2026-11-06T08-00-00-000Z.md');
    expect(latest?.head.split('\n')).toHaveLength(12);
  });

  test('no report, or one that vanished before it was read, is no latest report', async () => {
    const none = folder({});
    expect(
      await new FileWardenArtifacts(none.files, new WardenReportReader(none.files, DIR), DIR).latest(),
    ).toBeUndefined();

    const path = `${DIR}/a.md`;
    const listed: WardenReportFileSystem = {
      listFiles: async () => [{ path, mtimeMs: 1 }],
      readText: async () => undefined,
      writeTextAtomic: async () => undefined,
    };
    expect(await new FileWardenArtifacts(listed, new WardenReportReader(listed, DIR), DIR).latest()).toBeUndefined();
  });
});

describe("the warden report artifacts: an investigator's report is its last signal", () => {
  const report = `${DIR}/a.md`;
  const artifacts = (texts: Record<string, string>, summaryOf: (id: string) => Promise<string | undefined>) => {
    const world = folder(texts);
    return {
      world,
      artifacts: new FileWardenArtifacts(world.files, new WardenReportReader(world.files, DIR), DIR, summaryOf),
    };
  };
  const sidecar = { [provenancePath(report)]: JSON.stringify(spawn) };

  test('the summary of the investigator the sidecar names is filed as the report, once', async () => {
    const asked: string[] = [];
    const { world, artifacts: subject } = artifacts(sidecar, async id => {
      asked.push(id);
      return 'Verdict: LEAVE\n';
    });

    const first = await subject.readReport(report);
    const second = await subject.readReport(report);

    expect(first).toContain('Verdict: LEAVE');
    expect(second).toContain('Verdict: LEAVE');
    expect(world.written.get(report)).toBe('Verdict: LEAVE\n');
    expect(asked).toEqual(['wd-1']);
  });

  test('a report already filed is never replaced by the summary', async () => {
    const { world, artifacts: subject } = artifacts(
      { ...sidecar, [report]: 'Verdict: NUDGE\n' },
      async () => 'Verdict: LEAVE\n',
    );

    expect(await subject.readReport(report)).toContain('Verdict: NUDGE');
    expect(world.written.size).toBe(0);
  });

  test('no summary, a blank one, no sidecar or no reader files nothing', async () => {
    for (const summary of [undefined, '  \n']) {
      const { world, artifacts: subject } = artifacts(sidecar, async () => summary);
      expect(await subject.readReport(report)).toBeUndefined();
      expect(world.written.size).toBe(0);
    }
    const unnamed = artifacts({}, async () => 'Verdict: LEAVE\n');
    expect(await unnamed.artifacts.readReport(report)).toBeUndefined();
    const world = folder(sidecar);
    const plain = new FileWardenArtifacts(world.files, new WardenReportReader(world.files, DIR), DIR);
    expect(await plain.readReport(report)).toBeUndefined();
    expect(world.written.size).toBe(0);
  });
});
