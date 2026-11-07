import { describe, expect, test } from 'bun:test';
import { owner } from '@ferretry/kernel/testing';
import { WARDEN_CONFIG, WARDEN_JEV_CHECKS, WARDEN_REPORTS, WARDEN_STATE } from '../../contract/index.ts';
import { StateAutoMoveLedger } from '../../daemon/adapters/state-store.ts';
import { FileWardenArtifacts } from '../../daemon/adapters/artifacts.ts';
import { StateWardenReportFiles } from '../../daemon/adapters/report-files.ts';
import { WardenReportReader } from '../../daemon/adapters/report-reader.ts';
import manifest from '../../manifest.ts';
import { wardenState } from '../support/kernel.ts';
import { wardenHost } from './host.ts';

describe('storage parity', () => {
  test('F-0354 F-0360 F-0361 the warden keeps its files in its own state folder: state, reports, jev-checks, remembered', () => {
    expect(manifest.data.state.map(file => [file.name, file.path, file.store, file.format])).toEqual([
      ['state', 'state.json', 'json', 1],
      ['reports', 'reports/*', 'opaque', 1],
      ['jev-checks', 'jev-checks/*.json', 'json', 1],
      ['remembered', 'remembered.json', 'json', 1],
    ]);
    expect([WARDEN_STATE.path, WARDEN_REPORTS.path, WARDEN_JEV_CHECKS.path]).toEqual([
      'state.json',
      'reports/*',
      'jev-checks/*.json',
    ]);
  });

  test('F-0362 F-0413 the sweep memory is state.json, format 1 first, written by a sweep', async () => {
    const { host } = await wardenHost();

    const response = await host.request('POST', '/v1/warden/run', { as: owner() });

    expect(response.status).toBe(200);
    const stored = JSON.parse(host.state('warden').raw(WARDEN_STATE) as string) as Record<string, unknown>;
    expect(Object.keys(stored)[0]).toBe('format');
    expect(stored.format).toBe(1);
  });

  test('F-0177 F-0421 the settings are config/warden.yaml: the file under the defaults, a loosening held for the owner', async () => {
    expect(manifest.data.config).toEqual([WARDEN_CONFIG]);
    expect(WARDEN_CONFIG.file).toBe('warden.yaml');
    expect(WARDEN_CONFIG.axis).toBe('configure');
    const { host } = await wardenHost({ config: { enabled: false } });

    const view = (await host.request('GET', '/v1/warden/config', { as: owner() })).json<{
      config: { enabled: boolean; autoMove: unknown };
    }>();

    expect(view.config.enabled).toBe(false);
    expect(view.config.autoMove).toBeDefined();
    expect(typeof WARDEN_CONFIG.loosens).toBe('function');
  });

  test('F-0359 F-0081 the move ledger (today auto-migrate.json) lives under its own key of state.json and survives a sweep write', async () => {
    const state = wardenState();
    const ledger = new StateAutoMoveLedger(state);

    await ledger.write({ moves: [] } as never);
    await state.update(
      WARDEN_STATE,
      current => ({ ...current, format: 1 as const, lastSweepAt: '2026-11-07T12:00:00.000Z' }) as never,
    );

    expect(await ledger.read()).toEqual({ moves: [] });
    expect(JSON.stringify(state.folder.raw(WARDEN_STATE))).not.toContain('migrat');
  });

  test('F-0425 F-0361 a report is named for the instant it was commissioned, colons and dots replaced, with the target after it', () => {
    const files = new StateWardenReportFiles(wardenState());
    const artifacts = new FileWardenArtifacts(files, new WardenReportReader(files, 'reports'), 'reports');

    expect(artifacts.reportPath('2026-11-07T12:00:00.000Z', 'f1')).toBe('reports/2026-11-07T12-00-00-000Z-f1.md');
    expect(artifacts.reportPath('2026-11-07T12:00:00.000Z')).toBe('reports/2026-11-07T12-00-00-000Z.md');
  });
});
