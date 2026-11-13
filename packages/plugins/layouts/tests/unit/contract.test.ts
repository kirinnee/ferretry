import { describe, expect, test } from 'bun:test';
import {
  BUILT_IN_LAYOUTS,
  BUILT_IN_THEMES,
  LayoutSchema,
  LayoutSelectionSchema,
  ThemeSchema,
} from '../../contract/index.ts';
import { fakeLayouts, layoutsConformance } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

const read = async (path: string): Promise<unknown> =>
  Bun.YAML.parse(await Bun.file(new URL(`../../${path}`, import.meta.url)).text());

describe('layouts contract', () => {
  test('the fake passes the conformance suite', async () => {
    expect((await layoutsConformance(fakeLayouts)).ok).toBe(true);
  });

  test('every layout and theme the manifest brings is a valid file, and is the built-in the daemon serves', async () => {
    for (const layout of manifest.ui.layouts) {
      const parsed = LayoutSchema.parse(await read(layout.file));
      expect(parsed.id).toBe(layout.id);
      expect(BUILT_IN_LAYOUTS.find(item => item.id === layout.id)).toEqual(parsed);
    }
    for (const theme of manifest.ui.themes) {
      const parsed = ThemeSchema.parse(await read(theme.file));
      expect(parsed.id).toBe(theme.id);
      expect(BUILT_IN_THEMES.find(item => item.id === theme.id)).toEqual(parsed);
    }
    expect(BUILT_IN_LAYOUTS.length).toBe(manifest.ui.layouts.length);
    expect(BUILT_IN_THEMES.length).toBe(manifest.ui.themes.length);
  });

  test('reads are for any issued credential and ungoverned; every write is a person act on fleet.configure', () => {
    for (const route of manifest.actions.routes) {
      if (route.method === 'GET') {
        expect(route.minimum).toBe('authenticated');
        expect(route.capability).toBeUndefined();
      } else {
        expect(route.caller).toBe('person');
        expect(route.capability?.axis).toBe('configure');
      }
    }
  });

  test('the default layout lists the Files panel, or the side column would never show a ferret’s files', () => {
    const panels = BUILT_IN_LAYOUTS.find(layout => layout.id === 'default')?.panels['ferret.side'];
    expect(panels).toContain('files');
  });

  test('an empty config/layout.yaml selects the default layout and theme with no overrides', () => {
    expect(LayoutSelectionSchema.parse({})).toEqual({ layout: 'default', theme: 'default', overrides: {} });
  });

  test('a hand-written layout the app would refuse is refused here too (side.show is never, not none)', () => {
    const bad = { ...BUILT_IN_LAYOUTS[0], side: { show: 'none', holds: 'ferret' } };
    expect(LayoutSchema.safeParse(bad).success).toBe(false);
  });
});

test('the theme contract refuses unknown names and values outside the app token grammar', () => {
  const theme = { id: 'dusk', label: 'Dusk', base: 'neo' };
  for (const mode of ['light', 'dark']) {
    for (const tokens of [
      { accent: 'red' },
      { unknown: '#123456' },
      { accent: '#123456; color: red' },
      { 'font-body': 'url(evil)' },
      { 'flow-1': 'calc(1px)' },
    ])
      expect(ThemeSchema.safeParse({ ...theme, [mode]: tokens }).success).toBe(false);
    expect(
      ThemeSchema.safeParse({
        ...theme,
        [mode]: { accent: '#123456', 'font-body': "'System UI', sans-serif", 'flow-1': '1.25rem' },
      }).success,
    ).toBe(true);
  }
});
