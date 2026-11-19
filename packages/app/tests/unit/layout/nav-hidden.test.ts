import { describe, expect, test } from 'bun:test';
import type { Manifest } from '@ferretry/kernel/manifest';
import { LayoutSchema } from '@ferretry/plugin-layouts/contract';
import { navCatalogEntries, planFrame, viewsOf } from '../../../src/layout/engine.ts';
import { resolveLayout, setDeviceOverride } from '../../../src/layout/layout.ts';
import { navCatalogItems } from '../../../src/layout/nav-catalog.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';

function plugin(id: string, ui: NonNullable<Manifest['ui']>): SurfaceEntry {
  const manifest = { id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['view'], ui } as Manifest;
  return { id, title: id, core: false, contract: 'h', consumes: [], manifest };
}

const nav = (label: string, order: number, icon?: string) => ({
  label,
  order,
  ...(icon === undefined ? {} : { icon }),
});
const surfaces = [
  plugin('agenda', { screens: [{ id: 'agenda', path: 'agenda', nav: nav('Agenda', 10, 'bell') }] }),
  plugin('ferrets', {
    screens: [
      { id: 'ferrets', path: 'ferrets', nav: nav('Ferrets', 5, 'paw') },
      { id: 'move', path: 'ferrets/:ferret/move' },
    ],
  }),
  plugin('board', { screens: [{ id: 'board', path: 'board', nav: nav('Board', 30) }] }),
  plugin('lessons', { screens: [{ id: 'lessons', path: 'lessons', nav: nav('Lessons', 70) }] }),
];
const views = viewsOf(surfaces);

const layoutWith = (navPart: Record<string, unknown>) =>
  LayoutSchema.parse({ id: 'mine', nav: { side: 'left', style: 'rail', items: [], ...navPart } });
const keys = (layout: ReturnType<typeof layoutWith>, viewport: 'wide' | 'phone' = 'wide') =>
  planFrame(resolveLayout(layout, viewport), views).nav.entries.map(entry =>
    entry.kind === 'shell' ? entry.item : `${entry.screen.plugin}.${entry.screen.id}`,
  );

describe('a layout that never names hidden', () => {
  test('lists exactly its items, as before', () => {
    expect(keys(layoutWith({ items: ['board', 'ferrets'] }))).toEqual(['board.board', 'ferrets.ferrets']);
  });

  test('an empty list shows nothing and nothing is appended', () => {
    expect(keys(layoutWith({ items: [] }))).toEqual([]);
  });
});

describe('a layout that names hidden', () => {
  test('items are an order; every other nav place follows by its declared order, Settings last', () => {
    expect(keys(layoutWith({ items: ['board'], hidden: [] }))).toEqual([
      'board.board',
      'ferrets.ferrets',
      'agenda.agenda',
      'lessons.lessons',
      'settings',
    ]);
  });

  test('hidden places are dropped, whether named bare or qualified, listed or not', () => {
    expect(
      keys(layoutWith({ items: ['board', 'ferrets'], hidden: ['agenda', 'ferrets.ferrets', 'settings'] })),
    ).toEqual(['board.board', 'lessons.lessons']);
  });

  test('a place named twice appears once and a name that resolves to nothing is skipped', () => {
    expect(
      keys(layoutWith({ items: ['board', 'board.board', 'gone'], hidden: ['agenda', 'lessons', 'settings'] })),
    ).toEqual(['board.board', 'ferrets.ferrets']);
  });

  test('a screen with no nav entry is never appended', () => {
    expect(keys(layoutWith({ hidden: [] }))).not.toContain('ferrets.move');
  });

  test('a newly installed plugin shows up without anyone editing the layout', () => {
    const layout = layoutWith({ items: ['ferrets'], hidden: [] });
    const more = viewsOf([
      ...surfaces,
      plugin('sharing', { screens: [{ id: 'sharing', path: 's', nav: nav('Sharing', 20) }] }),
    ]);
    const ids = planFrame(resolveLayout(layout, 'wide'), more).nav.entries.map(entry =>
      entry.kind === 'screen' ? entry.screen.id : entry.item,
    );
    expect(ids).toEqual(['ferrets', 'agenda', 'sharing', 'board', 'lessons', 'settings']);
  });

  test('the phone inherits hidden, and its own hidden replaces it', () => {
    const inherited = layoutWith({ items: ['board'], hidden: ['agenda'] });
    expect(keys(inherited, 'phone')).not.toContain('agenda.agenda');
    const own = LayoutSchema.parse({
      ...inherited,
      phone: { nav: { hidden: ['board'] } },
    });
    const phone = keys(own, 'phone');
    expect(phone).not.toContain('board.board');
    expect(phone).toContain('agenda.agenda');
  });
});

describe('the nav catalog', () => {
  test('one entry per screen that declares a nav entry, in declared order, then Settings', () => {
    expect(navCatalogItems(navCatalogEntries(views)).map(item => [item.id, item.label, item.icon])).toEqual([
      ['ferrets.ferrets', 'Ferrets', 'paw'],
      ['agenda.agenda', 'Agenda', 'bell'],
      ['board.board', 'Board', undefined],
      ['lessons.lessons', 'Lessons', undefined],
      ['settings', 'Settings', 'settings'],
    ]);
  });

  test('its ids are names a layout can list and the plan resolves', () => {
    const ids = navCatalogItems(navCatalogEntries(views)).map(item => item.id);
    expect(keys(layoutWith({ items: ids }))).toEqual(ids);
  });
});

describe('saving hidden', () => {
  const base = layoutWith({ items: ['board'] });
  test('nav.hidden and phone.nav.hidden are list settings', () => {
    const set = setDeviceOverride(base, {}, 'nav.hidden', 'agenda, lessons');
    expect(set).toEqual({ ok: true, overrides: { nav: { hidden: ['agenda', 'lessons'] } } });
    const phone = setDeviceOverride(base, {}, 'phone.nav.hidden', '');
    expect(phone).toEqual({ ok: true, overrides: { phone: { nav: { hidden: [] } } } });
  });
});
