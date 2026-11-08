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
