/** Parity rows F-0017, F-0087, F-0352, F-0353, F-0369, F-0400, F-0418 (docs/design/rebuild-parity.tsv). */
import { describe, expect, test } from 'bun:test';
import type { Log, StatePort } from '@ferretry/kernel/contract';
import { StateUpdateDocuments } from '../../daemon/adapters/documents.ts';
import {
  UPDATES_CONFIG,
  UPDATES_LATEST,
  UPDATES_LOG,
  UPDATES_REPORT,
  UpdatesConfigSchema,
} from '../../contract/index.ts';
import manifest from '../../manifest.ts';

const quiet: Log = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

/** A state port that keeps what it is given by the declared file, and says which files it was asked for. */
function memoryState() {
  const files = new Map<string, unknown>();
  const touched: string[] = [];
  const port = {
    read: async (file: { path: string }) => {
      touched.push(file.path);
      return { ok: true, value: files.get(file.path) };
    },
    write: async (file: { path: string }, value: unknown) => {
      touched.push(file.path);
      files.set(file.path, value);
    },
    remove: async (file: { path: string }) => {
      touched.push(file.path);
      files.delete(file.path);
    },
  } as unknown as StatePort;
  return { port, files, touched };
}

const CHECK = {
  state: 'ok',
  checkedAt: '2026-10-18T09:00:00.000Z',
  latest: { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' },
} as const;

describe('the update files', () => {
  test('F-0352 F-0353 the update keeps its documents under its own state folder, one file per document', () => {
    expect(manifest.data.state.map(file => [file.name, file.path])).toEqual([
      ['latest', 'update/latest.json'],
      ['report', 'update/report.json'],
      ['log', 'update.log'],
    ]);
    expect(manifest.data.state.every(file => file.format === 1)).toBe(true);
  });

  test('F-0369 the last check is written to and read from latest.json', async () => {
    const state = memoryState();
    const documents = new StateUpdateDocuments(state.port, quiet);
    expect(await documents.readLatest()).toBeUndefined();
    await documents.writeLatest(CHECK as never);
    expect(await documents.readLatest()).toEqual(CHECK as never);
    expect(state.touched.every(path => path === UPDATES_LATEST.path)).toBe(true);
  });

  test('F-0400 the report is read from report.json and removed from it when a new update starts', async () => {
    const state = memoryState();
    const report = {
      from: '4.28.0',
      target: '4.29.0',
      outcome: 'succeeded',
      message: 'Updated.',
      finishedAt: '2026-10-18T10:00:00.000Z',
    };
    state.files.set(UPDATES_REPORT.path, report);
    const documents = new StateUpdateDocuments(state.port, quiet);
    expect(await documents.readReport()).toEqual(report as never);
    await documents.removeReport();
    expect(await documents.readReport()).toBeUndefined();
  });

  test('F-0017 F-0418 the update process writes its output to update.log', () => {
    expect(UPDATES_LOG.path).toBe('update.log');
    expect(UPDATES_LOG.store).toBe('opaque');
  });

  test('F-0087 the setting moves from config.json to config/updates.yaml, off until the owner turns it on', () => {
    expect(UPDATES_CONFIG.file).toBe('updates.yaml');
    expect(UpdatesConfigSchema.parse({})).toEqual({ autoInstall: false });
    expect(manifest.data.config.map(config => (config.shape === 'file' ? config.file : config.collection))).toEqual([
      'updates.yaml',
    ]);
  });
});
