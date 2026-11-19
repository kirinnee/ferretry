import { describe, expect, test } from 'bun:test';
import { DEFAULT_LAYOUT, LayoutSchema } from '../../../contract/index.ts';
import {
  changesOf,
  humanize,
  listedPlaces,
  navPlaces,
  navSources,
  type PlaceSource,
  placesOf,
  sourcesFromNames,
  withHidden,
} from '../../../app/lib/list-places.ts';

const sources: readonly PlaceSource[] = [
  { id: 'ferrets.ferrets', label: 'Ferrets', aliases: ['ferrets'] },
  { id: 'agenda.agenda', label: 'Agenda', aliases: ['agenda'] },
  { id: 'board.board', label: 'Board', aliases: ['board'] },
  { id: 'settings', label: 'Settings' },
];

describe('the list rows', () => {
  test('a layout that names no hidden list shows exactly its items; the rest of the set is hidden', () => {
    const rows = navPlaces(['agenda', 'settings'], undefined, sources);
    expect(rows.map(row => [row.id, row.hidden])).toEqual([
      ['agenda.agenda', false],
      ['settings', false],
      ['ferrets.ferrets', true],
      ['board.board', true],
    ]);
  });

  test('a layout that names hidden makes items an order: every other place shows, a new one included', () => {
    const rows = navPlaces(['board'], ['agenda'], sources);
    expect(rows.map(row => [row.id, row.hidden])).toEqual([
      ['board.board', false],
      ['ferrets.ferrets', false],
      ['agenda.agenda', true],
      ['settings', false],
    ]);
  });

  test('Settings is locked on, even when a layout names it hidden', () => {
    const rows = navPlaces([], ['settings'], sources);
    expect(rows.find(row => row.id === 'settings')).toMatchObject({ hidden: false, locked: true });
    expect(withHidden(rows, 'settings', true).find(row => row.id === 'settings')?.hidden).toBe(false);
  });

  test('a name that is not installed, or an alias two places share, is skipped', () => {
    const shared = [
      { id: 'a.x', label: 'A', aliases: ['x'] },
      { id: 'b.x', label: 'B', aliases: ['x'] },
    ];
    expect(navPlaces(['ghost', 'x'], [], shared).map(row => row.id)).toEqual(['a.x', 'b.x']);
  });

  test('the top bar and panels list what they name, in order, then the rest hidden; an unknown name is kept', () => {
    const rows = listedPlaces(['search', 'mystery'], sourcesFromNames(['daemon-picker', 'search', 'status']));
    expect(rows.map(row => [row.id, row.hidden])).toEqual([
      ['search', false],
      ['mystery', false],
      ['daemon-picker', true],
      ['status', true],
    ]);
  });

  test('rows turn back into the keys to save: nav saves order and hidden together, others the visible names', () => {
    const rows = withHidden(navPlaces(['ferrets', 'agenda'], [], sources), 'agenda.agenda', true);
    expect(changesOf('nav.items', rows)).toEqual([
      { path: 'nav.items', value: 'ferrets.ferrets,agenda.agenda,board.board,settings' },
      { path: 'nav.hidden', value: 'agenda.agenda' },
    ]);
    expect(changesOf('phone.nav.items', rows)[1]?.path).toBe('phone.nav.hidden');
    expect(changesOf('top', listedPlaces(['search'], sourcesFromNames(['daemon-picker', 'search'])))).toEqual([
      { path: 'top', value: 'search' },
    ]);
  });

  test('a phone list follows the wide one until it names its own', () => {
    const wide = LayoutSchema.parse({
      ...DEFAULT_LAYOUT,
      nav: { ...DEFAULT_LAYOUT.nav, hidden: ['board'] },
      phone: undefined,
    });
    expect(
      placesOf(wide, 'phone.nav.items', sourcesFromNames(['ferrets', 'board'])).find(r => r.id === 'board')?.hidden,
    ).toBe(true);
  });

  test('the nav catalog gives each screen its bare id as an alias only when no other shares it', () => {
    const item = (plugin: string, id: string) =>
      ({
        id: `${plugin}.${id}`,
        label: id,
        icon: undefined,
        order: 0,
        entry: { kind: 'screen', screen: { plugin, id } },
      }) as never;
    expect(navSources([item('a', 'x'), item('b', 'x'), item('c', 'y')]).map(source => source.aliases)).toEqual([
      undefined,
      undefined,
      ['y'],
    ]);
  });

  test('a name with no label is spoken in words', () => {
    expect(humanize('daemon-picker')).toBe('Daemon picker');
    expect(humanize('board.board')).toBe('Board');
  });
});
