import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { PackView } from '../../../contract/index.ts';
import app from '../../../app/index.ts';
import { PackSettingsSurface } from '../../../app/features/pack/pack-settings.tsx';
import type { PacksClient } from '../../../app/lib/client.ts';
import type { ConfigFiles } from '../../../app/lib/pack-config.ts';
import manifest from '../../../manifest.ts';
import { type Mounted, mount } from '../support/dom.ts';
import { textOf } from '../support/learning-dom.ts';
import { IDLE_ROUTING_API, PACK_VIEW } from '../support/pack.ts';

const half = app.build?.({ manifest, client: {} as never });
const settingsSource = readFileSync(new URL('../../../app/features/pack/pack-settings.tsx', import.meta.url), 'utf8');

/** A label the Settings › Pack mode panel draws, as it is written in the panel's own catalogs. */
const draws = (label: string): boolean => settingsSource.includes(`label: '${label}'`);

/**
 * Today's Settings › Pack mode screen is this plugin's one Settings tab, and the helpers panel beside a ferret is its one
 * panel. The rows are held at the registry (the manifest and the half's entries) and on the RENDERED screen: the
 * surface drawn with the shell's real primitives (`@ferretry/app/ui`); the tab mounted over the kernel's configuration-file
 * routes is held in `pack-settings-routes.test.tsx`.
 */
const client = { call: () => new Promise(() => undefined) } as unknown as PacksClient;
const NO_FILES = {} as ConfigFiles;

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

/** The Pack mode surface as it renders with the shell's primitives, ready on a view. */
const rendered = async (view: PackView = PACK_VIEW): Promise<string> => {
  await shown?.unmount();
  shown = await mount(
    <PackSettingsSurface
      client={client}
      configFiles={NO_FILES}
      state={{ read: { kind: 'ready', view }, saveConfig: async () => ({ kind: 'applied' }), ...IDLE_ROUTING_API }}
    />,
  );
  return textOf(shown.container);
};

describe('app parity, rendered', () => {
  test('S-0069 S-0170 S-0443 S-0492 S-0491 S-0447 S-0507 S-0570 S-0454 S-0574 the surface draws every setting', async () => {
    const text = await rendered();
    for (const label of [
      'Agent decides',
      'Jev decides',
      'Helpers for an interactive ferret',
      'Helpers for an unattended ferret',
      'Deepest nesting',
      'Probe timeout (seconds)',
      'Trust a passed probe for (seconds)',
    ])
      expect(text).toContain(label);
    // Jev's cap is asked only while Jev decides.
    expect(text).not.toContain('Jev’s daily cap (USD)');
    const jev = await rendered({ ...PACK_VIEW, config: { ...PACK_VIEW.config, decision: 'jev' } });
    expect(jev).toContain('Jev’s daily cap (USD)');
  });

  test("S-0169 S-0521 S-0522 the Pack mode tab is the half's one settings entry, mounted over the config routes (pack-settings-routes.test.tsx)", () => {
    expect(typeof half?.settings.pack).toBe('function');
  });
});

describe('app parity', () => {
  test('S-0069 S-0168 S-0169 S-0170 the connected settings, panel, surface and view are the one Pack mode tab', () => {
    expect(manifest.ui?.settings?.map(tab => [tab.id, tab.label])).toEqual([['pack', 'Pack mode']]);
    expect(typeof half?.settings.pack).toBe('function');
    expect(settingsSource).toContain('function PackSettingsView');
    expect(settingsSource).toContain('function PackPanel');
    expect(settingsSource).toContain('export function PackSettingsSurface');
    expect(settingsSource).toContain('function ConnectedPackSettings');
  });

  test('S-0315 the pack feature folder is this app half: the tab, the helpers panel and the Pack card', () => {
    expect(Object.keys(half?.settings ?? {})).toEqual(['pack']);
    expect(manifest.ui?.panels?.map(panel => panel.id)).toEqual(['helpers', 'pack-call']);
    expect(Object.keys(half?.panels ?? {})).toEqual(['helpers', 'pack-call']);
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
