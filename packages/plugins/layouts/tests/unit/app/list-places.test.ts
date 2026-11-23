import { describe, expect, test } from 'bun:test';
import { DEFAULT_LAYOUT, LayoutSchema } from '../../../contract/index.ts';
import {
  changesOf,
  humanize,
  keepPhoneNav,
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

  test('a shell item the engine accepts (Daemons) is kept although the catalog does not offer it', () => {
    const rows = navPlaces(['ferrets', 'daemons', 'settings'], undefined, sources);
    expect(rows.map(row => [row.id, row.hidden])).toEqual([
      ['ferrets.ferrets', false],
      ['daemons', false],
      ['settings', false],
      ['agenda.agenda', true],
      ['board.board', true],
    ]);
    expect(changesOf('nav.items', rows)[0]?.value).toContain('daemons');
    expect(changesOf('nav.items', withHidden(rows, 'daemons', true))[1]?.value).toContain('daemons');
  });

  test('a wide edit writes the phone its own hidden list when the phone names items but no hidden', () => {
    const legacy = LayoutSchema.parse({
      ...DEFAULT_LAYOUT,
      nav: { ...DEFAULT_LAYOUT.nav, items: ['ferrets', 'settings'] },
      phone: { nav: { items: ['ferrets', 'board', 'settings'] } },
    });
    const wide = changesOf('nav.items', navPlaces(['ferrets', 'settings'], undefined, sources));
    const kept = keepPhoneNav(legacy, 'nav.items', sources, wide);
    expect(kept.at(-1)).toEqual({ path: 'phone.nav.hidden', value: 'agenda.agenda' });
    // the phone still shows exactly Ferrets, Board and Settings
    const phone = placesOf(
      LayoutSchema.parse({
        ...legacy,
        nav: { ...legacy.nav, hidden: ['ferrets.ferrets'] },
        phone: { nav: { items: ['ferrets', 'board', 'settings'], hidden: ['agenda.agenda'] } },
      }),
      'phone.nav.items',
      sources,
    );
    expect(phone.filter(row => !row.hidden).map(row => row.id)).toEqual(['ferrets.ferrets', 'board.board', 'settings']);
  });

  test('nothing is added for a phone that names its own hidden, no items, or another key', () => {
    const base = changesOf('nav.items', navPlaces(['ferrets'], undefined, sources));
    const own = LayoutSchema.parse({ ...DEFAULT_LAYOUT, phone: { nav: { items: ['ferrets'], hidden: [] } } });
    const none = LayoutSchema.parse({ ...DEFAULT_LAYOUT, phone: undefined });
    const items = LayoutSchema.parse({ ...DEFAULT_LAYOUT, phone: { nav: { items: ['ferrets'] } } });
    expect(keepPhoneNav(own, 'nav.items', sources, base)).toEqual(base);
    expect(keepPhoneNav(none, 'nav.items', sources, base)).toEqual(base);
    expect(keepPhoneNav(items, 'top', sources, base)).toEqual(base);
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

  describe('a place that is not offered (work is off) survives an edit of another place', () => {
    // Work off: Board and Agenda are not in the catalog at all, yet the saved layout still orders and hides them.
    const offered: readonly PlaceSource[] = [
      { id: 'ferrets.ferrets', label: 'Ferrets', aliases: ['ferrets'] },
      { id: 'projects.projects', label: 'Projects', aliases: ['projects'] },
      { id: 'settings', label: 'Settings' },
    ];
    const saved = LayoutSchema.parse({
      ...DEFAULT_LAYOUT,
      nav: { ...DEFAULT_LAYOUT.nav, items: ['ferrets', 'agenda', 'board', 'projects', 'settings'], hidden: ['board'] },
    });
    const rowsOf = () => placesOf(saved, 'nav.items', offered);

    test('hiding Projects keeps Board in nav.hidden and both in their order in nav.items (item 2)', () => {
      const [items, hidden] = changesOf('nav.items', withHidden(rowsOf(), 'projects.projects', true), {
        layout: saved,
        sources: offered,
      });
      expect(hidden?.value.split(',')).toContain('board');
      expect(hidden?.value.split(',')).toContain('projects.projects');
      expect(items?.value.split(',')).toEqual(['ferrets.ferrets', 'agenda', 'board', 'projects.projects', 'settings']);
    });

    test('without the layout to carry over (the old call), they are dropped: the loss this fixes', () => {
      const [items, hidden] = changesOf('nav.items', withHidden(rowsOf(), 'projects.projects', true));
      expect(items?.value).not.toContain('board');
      expect(hidden?.value).not.toContain('board');
    });

    test('reordering keeps them after the place they followed; nothing is added twice', () => {
      const rows = rowsOf();
      const flipped = [rows[1], rows[0], ...rows.slice(2)] as typeof rows;
      const [items] = changesOf('nav.items', flipped, { layout: saved, sources: offered });
      expect(items?.value.split(',')).toEqual(['projects.projects', 'ferrets.ferrets', 'agenda', 'board', 'settings']);
    });

    test('with work on (a place is offered) nothing extra is carried', () => {
      const on = LayoutSchema.parse({
        ...DEFAULT_LAYOUT,
        nav: { ...DEFAULT_LAYOUT.nav, items: ['ferrets', 'agenda', 'board', 'settings'], hidden: ['board'] },
      });
      const [items, hidden] = changesOf('nav.items', placesOf(on, 'nav.items', sources), { layout: on, sources });
      expect(items?.value).toBe('ferrets.ferrets,agenda.agenda,board.board,settings');
      expect(hidden?.value).toBe('board.board');
    });

    test('the phone bar that inherits the wide hidden keeps Board hidden too', () => {
      const legacy = LayoutSchema.parse({
        ...saved,
        phone: { nav: { items: ['ferrets', 'board', 'settings'] } },
      });
      const wide = changesOf('nav.items', rowsOf(), { layout: legacy, sources: offered });
      const kept = keepPhoneNav(legacy, 'nav.items', offered, wide);
      expect(kept.at(-1)?.value.split(',')).toContain('board');
    });

    test('a side panel of a plugin that is off has no row, and a save keeps it in the list', () => {
      const side = ['ferret-agenda', 'queue', 'cards-of-ferret', 'terminals'];
      const layout = LayoutSchema.parse({ ...DEFAULT_LAYOUT, panels: { 'ferret.side': side } });
      const absent = new Set(['ferret-agenda', 'cards-of-ferret']);
      const panelSources = sourcesFromNames([...side, 'console']).filter(source => !absent.has(source.id));
      const rows = placesOf(layout, 'panels.ferret.side', panelSources, absent);
      expect(rows.map(row => row.id)).toEqual(['queue', 'terminals', 'console']);
      const [saved] = changesOf('panels.ferret.side', withHidden(rows, 'queue', true), {
        layout,
        sources: panelSources,
        absent,
      });
      expect(saved?.value).toBe('ferret-agenda,cards-of-ferret,terminals');
    });
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
    expect(humanize('mcp-servers')).toBe('MCP servers');
  });
});
