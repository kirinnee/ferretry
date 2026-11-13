import { describe, expect, test } from 'bun:test';
import { BUILT_IN_LAYOUTS } from '@ferretry/plugin-layouts/contract';
import { generated } from '../../../src/generated/surfaces.ts';
import { viewsOf } from '../../../src/layout/engine.ts';
import { checkLayout, chooseLayout } from '../../../src/layout/layout.ts';
import { routeTable } from '../../../src/router/routes.ts';
import { placeSource } from '../../../src/shell/command-sources.ts';
import { commandBarResults } from '../../../src/ui/command-bar-model.ts';

/**
 * The layouts Layouts ships name views by id. The manifests are the truth for those ids, so the shipped default and
 * compact layouts are proved against the real compiled manifests: a renamed screen or panel fails here, not in a
 * browser that quietly draws the built-in instead of the layout it was served.
 */
const installed = viewsOf(generated.surfaces).installed;

describe('the shipped layouts against the generated surfaces', () => {
  for (const layout of BUILT_IN_LAYOUTS) {
    test(`the ${layout.id} layout names only views a manifest declares`, () => {
      expect(checkLayout(layout, installed)).toEqual([]);
    });

    test(`the ${layout.id} layout is accepted by chooseLayout, never refused for the built-in`, () => {
      expect(chooseLayout([layout], installed)).toEqual({ kind: 'applied', layout });
    });

    test(`the ${layout.id} layout puts the ferret list first in the nav, on a wide screen and on a phone`, () => {
      expect(layout.nav.items[0]).toBe('ferrets');
      expect(layout.phone?.nav?.items?.[0]).toBe('ferrets');
    });
  }

  test('the default layout holds the ferret list in the side column, the compact one holds panels', () => {
    expect(BUILT_IN_LAYOUTS.map(layout => [layout.id, layout.side.holds])).toEqual([
      ['default', 'ferrets'],
      ['compact', 'panels'],
    ]);
  });
});

describe('the ferret list among the places the shell lists', () => {
  const views = viewsOf(generated.surfaces);

  test('is the first nav screen (order 5, before Agenda) and a place at /d/<daemon>/ferrets (S-0552)', () => {
    const screens = [...new Set(views.screens.values())];
    const ferrets = views.screens.get('ferrets');
    expect(ferrets).toMatchObject({ plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets', navOrder: 5 });
    const nav = screens
      .filter(screen => screen.navOrder !== undefined)
      .sort((left, right) => (left.navOrder ?? 0) - (right.navOrder ?? 0));
    expect(nav[0]?.id).toBe('ferrets');

    const went: string[] = [];
    const source = placeSource({
      daemons: [],
      daemon: 'dm1',
      screens,
      routes: routeTable(screens),
      navigate: href => went.push(href),
    });
    const place = commandBarResults([source], '').results.find(entry => entry.id === 'screen-ferrets.ferrets');
    expect(place).toMatchObject({ group: 'Go to', label: 'Ferrets' });
    place?.run();
    expect(went).toEqual(['/d/dm1/ferrets']);
  });
});
