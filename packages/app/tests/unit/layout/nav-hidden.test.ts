import { describe, expect, test } from 'bun:test';
import type { Manifest } from '@ferretry/kernel/manifest';
import { LayoutSchema } from '@ferretry/plugin-layouts/contract';
import { navCatalogEntries, planFrame, viewsOf } from '../../../src/layout/engine.ts';
import {
  checkLayout,
  chooseLayout,
  layoutCandidates,
  resolveLayout,
  setDeviceOverride,
} from '../../../src/layout/layout.ts';
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
    expect(keys(layoutWith({ items: ['board', 'ferrets'], hidden: ['agenda', 'ferrets.ferrets'] }))).toEqual([
      'board.board',
      'lessons.lessons',
      'settings',
    ]);
  });

  test('Settings is never hidden, on the wide nav or the phone, however it is named', () => {
    const hiding = layoutWith({ items: ['board'], hidden: ['settings', 'agenda'] });
    expect(keys(hiding)).toContain('settings');
    expect(keys(hiding)).not.toContain('agenda.agenda');
    expect(keys(hiding, 'phone')).toContain('settings');
    const phoneHiding = LayoutSchema.parse({ ...hiding, phone: { nav: { hidden: ['settings'] } } });
    expect(keys(phoneHiding, 'phone')).toContain('settings');
    expect(keys(layoutWith({ items: ['settings', 'board'], hidden: ['settings'] }))).toEqual([
      'settings',
      'board.board',
      'ferrets.ferrets',
      'agenda.agenda',
      'lessons.lessons',
    ]);
  });

  test('a place named twice appears once and a name that resolves to nothing is skipped', () => {
    expect(keys(layoutWith({ items: ['board', 'board.board', 'gone'], hidden: ['agenda', 'lessons'] }))).toEqual([
      'board.board',
      'ferrets.ferrets',
      'settings',
    ]);
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

describe('a layout naming a plugin that is no longer installed', () => {
  const installed = views.installed;
  const mine = (navPart: Record<string, unknown>, phone?: Record<string, unknown>) =>
    LayoutSchema.parse({
      id: 'mine',
      nav: { side: 'left', style: 'rail', items: [], ...navPart },
      ...(phone === undefined ? {} : { phone }),
    });

  test('is kept when it names hidden: stale items and hidden names are skipped, not refused', () => {
    const layout = mine({ items: ['lessons.lessons', 'gone', 'board'], hidden: ['removed'] });
    expect(checkLayout(layout, installed)).toEqual([]);
    const choice = chooseLayout(layoutCandidates(layout, {}), installed);
    expect(choice).toEqual({ kind: 'applied', layout });
    const withoutLessons = viewsOf(surfaces.filter(entry => entry.id !== 'lessons'));
    const stale = mine({ items: ['lessons.lessons', 'board'], hidden: ['agenda'] });
    const applied = chooseLayout(layoutCandidates(stale, {}), withoutLessons.installed);
    expect(applied).toEqual({ kind: 'applied', layout: stale });
    expect(
      planFrame(resolveLayout(stale, 'wide'), withoutLessons).nav.entries.map(entry =>
        entry.kind === 'shell' ? entry.item : entry.screen.id,
      ),
    ).toEqual(['board', 'ferrets', 'settings']);
  });

  test('is kept on the phone when the phone names hidden, inherited or its own', () => {
    const phoneOnly = mine({ items: ['board'], hidden: [] }, { nav: { items: ['gone'] } });
    expect(checkLayout(phoneOnly, installed)).toEqual([]);
    const ownHidden = mine({ items: ['board'], hidden: [] }, { nav: { items: ['gone'], hidden: ['agenda'] } });
    expect(checkLayout(ownHidden, installed)).toEqual([]);
  });

  test('is still refused whole by a layout that never names hidden', () => {
    const gone = mine({ items: ['gone'] });
    expect(checkLayout(gone, installed).map(issue => issue.at)).toEqual(['nav.items']);
    expect(chooseLayout([gone], installed)).toMatchObject({ kind: 'refused', refused: 'mine' });
  });

  test('a phone list is strict when only the wide nav is legacy', () => {
    const strictWide = mine({ items: ['gone'] }, { nav: { hidden: [] } });
    expect(checkLayout(strictWide, installed).map(issue => issue.at)).toEqual(['nav.items']);
    const strictPhone = mine({ items: ['board'] }, { nav: { items: ['gone'] } });
    expect(checkLayout(strictPhone, installed).map(issue => issue.at)).toEqual(['phone.nav.items']);
  });
});
