import { describe, expect, test } from 'bun:test';
import { BUILT_IN_LAYOUTS } from '@ferretry/plugin-layouts/contract';
import { generated } from '../../../src/generated/surfaces.ts';
import { planFrame, viewsOf } from '../../../src/layout/engine.ts';
import { resolveLayout } from '../../../src/layout/layout.ts';
import { ICONS, navIconName } from '../../../src/shell/icons.tsx';

/**
 * AN ICON ON EVERY SETTINGS ITEM AND EVERY APP DESTINATION (r8). The manifests are the truth for what exists, so this runs
 * over the real compiled surfaces: a plugin that adds a settings tab or a nav screen with no icon (or an icon name the one
 * icon set does not answer to) fails here, not as a bare label in someone's list. Group headings are not tabs and carry none.
 */
const surfaces = generated.surfaces;
const unknown = (name: string | undefined): boolean => name === undefined || ICONS[name] === undefined;

describe('every settings tab and destination has an icon from the one icon set', () => {
  test('every settings tab declares an icon the set answers to', () => {
    const tabs = surfaces.flatMap(entry =>
      (entry.manifest.ui?.settings ?? []).map(tab => ({ key: `${entry.id}/${tab.id}`, icon: tab.icon })),
    );
    expect(tabs.length).toBeGreaterThan(30);
    expect(tabs.filter(tab => unknown(tab.icon)).map(tab => tab.key)).toEqual([]);
  });

  test('every screen that is a nav destination declares an icon the set answers to', () => {
    const destinations = surfaces.flatMap(entry =>
      (entry.manifest.ui?.screens ?? [])
        .filter(screen => screen.nav !== undefined)
        .map(screen => ({ key: `${entry.id}.${screen.id}`, icon: screen.nav?.icon })),
    );
    expect(destinations.length).toBeGreaterThan(5);
    expect(destinations.filter(destination => unknown(destination.icon)).map(destination => destination.key)).toEqual(
      [],
    );
  });

  test('every nav entry of every shipped layout (the shell’s own Settings included) resolves to an icon', () => {
    const views = viewsOf(surfaces);
    const missing: string[] = [];
    for (const layout of BUILT_IN_LAYOUTS) {
      for (const viewport of ['wide', 'phone'] as const) {
        for (const entry of planFrame(resolveLayout(layout, viewport), views).nav.entries) {
          if (unknown(navIconName(entry)))
            missing.push(`${layout.id}/${viewport}: ${entry.kind === 'screen' ? entry.screen.id : entry.item}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('no two settings tabs of one plugin share an icon (each reads as its own item)', () => {
    const clashes = surfaces.flatMap(entry => {
      const seen = new Map<string, string>();
      return (entry.manifest.ui?.settings ?? []).flatMap(tab => {
        const clash = tab.icon === undefined ? undefined : seen.get(tab.icon);
        if (tab.icon !== undefined) seen.set(tab.icon, tab.id);
        return clash === undefined ? [] : [`${entry.id}: ${clash} and ${tab.id}`];
      });
    });
    expect(clashes).toEqual([]);
  });
});
