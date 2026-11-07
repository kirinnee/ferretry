import { describe, expect, test } from 'bun:test';
import { LayoutSchema, ThemeSchema } from '../../contract/index.ts';
import { fakeLayouts, layoutsConformance } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

const read = async (path: string): Promise<unknown> =>
  Bun.YAML.parse(await Bun.file(new URL(`../../${path}`, import.meta.url)).text());

describe('layouts contract', () => {
  test('the fake passes the conformance suite', async () => {
    expect((await layoutsConformance(fakeLayouts)).ok).toBe(true);
  });

  test('every layout and theme the manifest brings is a valid file', async () => {
    for (const layout of manifest.ui.layouts) {
      const parsed = LayoutSchema.parse(await read(layout.file));
      expect(parsed.id).toBe(layout.id);
    }
    for (const theme of manifest.ui.themes) {
      const parsed = ThemeSchema.parse(await read(theme.file));
      expect(parsed.id).toBe(theme.id);
    }
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
});
