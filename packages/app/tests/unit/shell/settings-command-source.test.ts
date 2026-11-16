import { describe, expect, it } from 'bun:test';
import type { Manifest } from '@ferretry/kernel/manifest';
import { settingsSource } from '../../../src/shell/command-sources.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { commandBarResults } from '../../../src/ui/command-bar-model.ts';

/** Every settings tab a plugin declares is a command bar destination, opening that tab on the reader's daemon. */

const entryOf = (id: string, settings: readonly Record<string, unknown>[]): SurfaceEntry => ({
  id,
  title: id,
  core: false,
  contract: 'hash',
  consumes: [],
  manifest: {
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: ['view'],
    ui: { settings },
  } as unknown as Manifest,
});

const surfaces = [
  entryOf('runtimes', [
    { id: 'agents', label: 'Agents', order: 13, keywords: ['permissions', 'auto-resume', 'keep in sync'] },
    { id: 'runtimes', label: 'Runtimes', order: 10 },
  ]),
  entryOf('warden', [{ id: 'warden', label: 'Warden', order: 60 }]),
  entryOf('board', []),
];

describe('settingsSource', () => {
  it('lists every plugin’s settings tab in the Settings page’s order, none on the resting list', () => {
    const entries = settingsSource({ daemon: 'd1', surfaces, navigate: () => undefined })('');
    expect(entries.map(entry => [entry.group, entry.label])).toEqual([
      ['Settings', 'Runtimes'],
      ['Settings', 'Agents'],
      ['Settings', 'Warden'],
    ]);
    expect(entries.some(entry => entry.resting === true)).toBe(false);
  });

  it('lists nothing before a daemon is chosen', () => {
    expect(settingsSource({ daemon: undefined, surfaces, navigate: () => undefined })('')).toEqual([]);
  });

  it('finds the Agents tab by the settings it holds, and opening it goes to that tab on this daemon', () => {
    const went: string[] = [];
    const source = settingsSource({ daemon: 'd1', surfaces, navigate: href => went.push(href) });
    for (const query of ['permissions', 'auto-resume', 'keep in sync', 'agents']) {
      const found = commandBarResults([source], query).results;
      expect(found.map(entry => entry.label)).toContain('Agents');
    }
    commandBarResults([source], 'permissions').results[0]?.run();
    expect(went).toEqual(['/d/d1/settings/runtimes/agents']);
  });
});
