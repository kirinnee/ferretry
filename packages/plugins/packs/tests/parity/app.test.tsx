import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import app from '../../app/index.ts';
import manifest from '../../manifest.ts';

const half = app.build?.({ manifest, client: {} as never });
const settingsSource = readFileSync(new URL('../../app/features/pack/pack-settings.tsx', import.meta.url), 'utf8');

/** A label the Settings › Pack mode panel draws, as it is written in the panel's own catalogs. */
const draws = (label: string): boolean => settingsSource.includes(`label: '${label}'`);

/**
 * Today's Settings › Pack mode screen is this plugin's one Settings tab, and the helpers panel beside a ferret is its one
 * panel. The views are React and load on first use, so these rows are held at the registry (the manifest and the half's
 * entries) and, for the panel's own words, at the catalogs they are written in; the rendered screen is the React suites
 * under tests/unit/app, which wait on the app shell (NEEDS-APP-SHELL.txt).
 */
describe('app parity', () => {
  test('S-0069 S-0168 S-0169 S-0170 the connected settings, panel, surface and view are the one Pack mode tab', () => {
    expect(manifest.ui?.settings?.map(tab => [tab.id, tab.label])).toEqual([['pack', 'Pack mode']]);
    expect(typeof half?.settings['pack']).toBe('function');
    expect(settingsSource).toContain('function PackSettingsView');
    expect(settingsSource).toContain('function PackPanel');
    expect(settingsSource).toContain('export function PackSettingsSurface');
    expect(settingsSource).toContain('function ConnectedPackSettings');
  });

  test('S-0315 the pack feature folder is this app half: the tab and the helpers panel', () => {
    expect(Object.keys(half?.settings ?? {})).toEqual(['pack']);
    expect(manifest.ui?.panels?.map(panel => panel.id)).toEqual(['helpers']);
    expect(Object.keys(half?.panels ?? {})).toEqual(['helpers']);
  });

  test('S-0422 S-0521 S-0522 the settings entry, navigation and catalog link resolve to the tab this half draws', () => {
    expect(manifest.ui?.settings?.some(tab => tab.id === 'pack')).toBe(true);
    expect(settingsSource).toContain("label: 'Pack mode'");
  });

  test('S-0443 S-0492 who decides is offered as Agent decides and Jev decides', () => {
    expect(draws('Agent decides')).toBe(true);
    expect(draws('Jev decides')).toBe(true);
  });

  test('S-0491 S-0447 S-0507 the limits are interactive helpers, unattended helpers and the deepest nesting', () => {
    expect(draws('Helpers for an interactive ferret')).toBe(true);
    expect(draws('Helpers for an unattended ferret')).toBe(true);
    expect(draws('Deepest nesting')).toBe(true);
  });

  test('S-0570 S-0454 the probe is a timeout and how long a passed probe is trusted', () => {
    expect(draws('Probe timeout (seconds)')).toBe(true);
    expect(draws('Trust a passed probe for (seconds)')).toBe(true);
  });

  test('S-0574 Jev’s daily cap is a setting in US dollars', () => {
    expect(draws('Jev’s daily cap (USD)')).toBe(true);
  });
});
