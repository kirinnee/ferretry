import { describe, expect, test } from 'bun:test';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { ConfigWardenConfigStore } from '../../daemon/adapters/config-store.ts';
import { FileWardenArtifacts } from '../../daemon/adapters/artifacts.ts';
import { StateWardenReportFiles } from '../../daemon/adapters/report-files.ts';
import { WardenReportReader } from '../../daemon/adapters/report-reader.ts';
import { buildWardenSpawnProvenance, provenancePath, type WardenReportFileSystem } from '../../daemon/lib/index.ts';
import { wardenConfig, wardenState } from '../support/kernel.ts';

const DIR = 'reports';
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

/** The reports as the warden keeps them: files in the warden state folder, read through the real adapters. */
function evidence() {
  const files = new StateWardenReportFiles(wardenState());
  const reader = new WardenReportReader(files, DIR);
  const artifacts = new FileWardenArtifacts(files, reader, DIR);
  return { files, reader, artifacts };
}

describe('the warden report reader over the state-backed report files', () => {
  test('a sidecar that is valid is read back, one that is missing, not JSON or fails its schema is no provenance', async () => {
    const { files, reader } = evidence();
    const valid = `${DIR}/a.md`;
    const broken = `${DIR}/b.md`;
    const wrong = `${DIR}/c.md`;
    await files.writeTextAtomic(provenancePath(valid), JSON.stringify(spawn));
    await files.writeTextAtomic(provenancePath(broken), '{not json');
    await files.writeTextAtomic(provenancePath(wrong), JSON.stringify({ v: 1 }));

    expect(await reader.readProvenance(valid)).toEqual(spawn);
    expect(await reader.readProvenance(`${DIR}/absent.md`)).toBeUndefined();
    expect(await reader.readProvenance(broken)).toBeUndefined();
    expect(await reader.readProvenance(wrong)).toBeUndefined();
  });

  test('a sidecar that cannot be read at all degrades to no provenance instead of failing the read', async () => {
    const faulty: WardenReportFileSystem = {
      listFiles: async () => [],
      readText: async () => {
        throw new Error('io fault');
      },
      writeTextAtomic: async () => undefined,
    };

    expect(await new WardenReportReader(faulty, DIR).readProvenance(`${DIR}/a.md`)).toBeUndefined();
  });

  test('a report is read with its provenance block on top, and a missing one as nothing', async () => {
    const { files, reader } = evidence();
    const report = `${DIR}/a.md`;
    await files.writeTextAtomic(report, 'VERDICT: cleared\n\nfine\n');
    await files.writeTextAtomic(provenancePath(report), JSON.stringify(spawn));

    const text = await reader.readReport(report);

    expect(text).toContain('fine');
    expect(text).toContain('sample-model');
    expect(await reader.readReport(`${DIR}/absent.md`)).toBeUndefined();
  });

  test('only a markdown file directly inside the reports folder is served by path', async () => {
    const { files, reader } = evidence();
    const report = `${process.cwd()}/${DIR}/a.md`;
    await files.writeTextAtomic(`${DIR}/a.md`, 'VERDICT: cleared\n\nfine\n');

    expect(await reader.readReportAt(report)).toContain('fine');
    expect(await reader.readReportAt(`${process.cwd()}/${DIR}/../x.md`)).toBeUndefined();
    expect(await reader.readReportAt(`${process.cwd()}/${DIR}/a.txt`)).toBeUndefined();
  });

  test('verdicts carry the spawn facts of the reports that have a sidecar, and an empty folder lists none', async () => {
    const { files, reader } = evidence();
    expect(await reader.readVerdicts()).toEqual([]);
    const withSidecar = `${DIR}/2026-11-06T10-00-00-000Z.md`;
    await files.writeTextAtomic(withSidecar, 'VERDICT: cleared\n\nfine\n');
    await files.writeTextAtomic(provenancePath(withSidecar), JSON.stringify(spawn));

    const verdicts = await reader.readVerdicts();

    expect(verdicts.map(verdict => verdict.reportPath)).toEqual([withSidecar]);
    expect(verdicts[0]?.spawn?.wardenSessionId).toBe('wd-1');
  });

  test('an empty report fails the list like an unreadable one, so the index reads unavailable, not quietly short', async () => {
    const { files, reader } = evidence();
    await files.writeTextAtomic(`${DIR}/2026-11-06T09-00-00-000Z.md`, '  \n');

    await expect(reader.readVerdicts()).rejects.toThrow('a Warden report could not be read');
  });

  test('a report that cannot be read fails the whole list rather than reading as a quiet history', async () => {
    const path = `${DIR}/bad.md`;
    const faulty: WardenReportFileSystem = {
      listFiles: async () => [{ path, mtimeMs: 1 }],
      readText: async () => {
        throw new Error('io fault');
      },
      writeTextAtomic: async () => undefined,
    };

    await expect(new WardenReportReader(faulty, DIR).readVerdicts()).rejects.toThrow(
      'a Warden report could not be read',
    );
  });
});

describe('the warden report artifacts over the state-backed report files', () => {
  test('a report path is derived from the instant, portable, with the target when there is one', () => {
    const { artifacts } = evidence();

    expect(artifacts.reportPath('2026-11-06T09:00:00.000Z', 'f1')).toBe(`${DIR}/2026-11-06T09-00-00-000Z-f1.md`);
    expect(artifacts.reportPath('2026-11-06T09:00:00.000Z')).toBe(`${DIR}/2026-11-06T09-00-00-000Z.md`);
  });

  test('a sidecar is written pretty-printed beside the report, never merged into it, and read back with it', async () => {
    const { files, artifacts } = evidence();
    const path = artifacts.reportPath('2026-11-06T09:00:00.000Z', 'f1');
    await files.writeTextAtomic(path, 'VERDICT: cleared\n\nit was fine\n');

    await artifacts.writeProvenance(path, spawn);

    expect(await files.readText(provenancePath(path))).toBe(`${JSON.stringify(spawn, null, 2)}\n`);
    expect(await files.readText(path)).not.toContain('sample-model');
    expect(await artifacts.readReport(path)).toContain('sample-model');
    expect(await artifacts.readReport(`${DIR}/absent.md`)).toBeUndefined();
  });

  test('the latest report is named by its filename with at most its first twelve lines', async () => {
    const { files, artifacts } = evidence();
    const long = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    await files.writeTextAtomic(artifacts.reportPath('2026-11-06T10:00:00.000Z', 'f2'), long);

    const latest = await artifacts.latest();

    expect(latest?.reportId).toBe('2026-11-06T10-00-00-000Z-f2.md');
    expect(latest?.head.split('\n')).toHaveLength(12);
  });

  test('no report, or one that vanished before it was read, is no latest report', async () => {
    expect(await evidence().artifacts.latest()).toBeUndefined();

    const path = `${DIR}/a.md`;
    const vanishing: WardenReportFileSystem = {
      listFiles: async () => [{ path, mtimeMs: 1 }],
      readText: async () => undefined,
      writeTextAtomic: async () => undefined,
    };
    const artifacts = new FileWardenArtifacts(vanishing, new WardenReportReader(vanishing, DIR), DIR);

    expect(await artifacts.latest()).toBeUndefined();
  });
});

describe('warden.yaml through the kernel config write port', () => {
  const doorOf = (state: 'valid' | 'held', result: ConfigWriteOutcome) =>
    Object.assign(wardenConfig({ caps: { jevUsdPerDay: 5 } }), {
      fileState: () => ({ state, inEffect: true, sentences: [] }) as never,
      write: async () => result,
      remove: async (): Promise<ConfigWriteOutcome> => ({ kind: 'written', etag: 'fixture', loosened: [] }),
    });

  test('a save that lands writes nothing held and says so with no sentences', async () => {
    const store = new ConfigWardenConfigStore(doorOf('valid', { kind: 'written', etag: 'e', loosened: [] }));

    expect(await store.write({} as never, {} as never)).toEqual([]);
  });

  test('a save while another edit waits for the owner is refused before anything is written', async () => {
    const store = new ConfigWardenConfigStore(doorOf('held', { kind: 'written', etag: 'e', loosened: [] }));

    await expect(store.write({} as never, {} as never)).rejects.toThrow('waiting for your approval');
  });

  test('a save over a file that moved since the kernel read it writes nothing and says to try again', async () => {
    const store = new ConfigWardenConfigStore(doorOf('valid', { kind: 'conflict', etag: 'e' } as never));

    await expect(store.write({} as never, {} as never)).rejects.toThrow('Try again');
  });

  test('a refusal with no issue messages falls back to the reason the kernel gave', async () => {
    const store = new ConfigWardenConfigStore(doorOf('valid', { kind: 'refused', reason: 'schema', issues: [] }));

    await expect(store.write({} as never, {} as never)).rejects.toThrow('schema');
  });
});
