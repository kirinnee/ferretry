import { describe, expect, test } from 'bun:test';
import {
  activeProjectFerrets,
  type FerretRow,
  projectFerrets,
  projectLaunchRequest,
} from '../../../app/lib/ferrets.ts';

const row = (id: string, folder: string, stateAt: string, state: FerretRow['state'] = 'working'): FerretRow => ({
  id,
  name: id,
  harness: 'claude-code',
  folder,
  state,
  stateAt,
});

describe('project detail model', () => {
  test('derives the exact normalized-folder ferret set, newest change first', () => {
    const set = projectFerrets('/work/registry/', [
      row('older', '/work/registry', '2026-08-01T00:00:00.000Z'),
      row('newer', '/work/registry/', '2026-08-03T00:00:00.000Z'),
      row('nested', '/work/registry/packages/app', '2026-08-04T00:00:00.000Z'),
    ]);

    expect(set.map(ferret => ferret.id)).toEqual(['newer', 'older']);
  });

  test('keeps the active projection derived from that set: a stopped ferret is not active', () => {
    const set = projectFerrets('/work/registry', [
      row('active', '/work/registry', '2026-08-01T00:00:00.000Z', 'idle'),
      row('finished', '/work/registry', '2026-08-02T00:00:00.000Z', 'stopped'),
    ]);

    expect(activeProjectFerrets(set).map(ferret => ferret.id)).toEqual(['active']);
  });
});

describe('projectLaunchRequest', () => {
  test('builds an interactive start rooted in the project folder', () => {
    expect(projectLaunchRequest('claude-code', '/work/ferretry')).toEqual({
      runtime: 'claude-code',
      folder: '/work/ferretry',
      mode: 'interactive',
    });
  });

  test('trims the typed runtime name rather than sending the whitespace with it', () => {
    expect(projectLaunchRequest('  codex \n', '/work/ferretry').runtime).toBe('codex');
  });

  test('refuses a blank runtime and an empty folder before asking the daemon', () => {
    expect(() => projectLaunchRequest('   ', '/work/ferretry')).toThrow();
    expect(() => projectLaunchRequest('claude', '')).toThrow();
  });
});
