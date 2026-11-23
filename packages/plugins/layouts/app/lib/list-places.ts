/**
 * THE LISTS OF A LAYOUT AS ROWS YOU MOVE AND SWITCH (Settings › Layout used to ask people to type the names). A list
 * key is a fixed set of places (the installed nav screens, the top bar's items, the ferret side panels), each shown or
 * hidden, in an order. Pure: it turns what the layout holds into rows, and the rows back into the keys to save, so the
 * tab never builds a name by hand.
 *
 * What "hidden" means differs by key and is spelled once here:
 *   - NAV: the layout's `hidden` list. A layout that never names `hidden` lists exactly its `items`, so a place missing
 *     from `items` is hidden; one that names it makes `items` an order and every place not hidden shows.
 *   - TOP BAR and SIDE PANELS: no hidden list; a place the list does not name is hidden.
 */
import { type NavCatalogItem, SHELL_ITEMS } from '@ferretry/app';
import type { Layout } from '../../contract/index.ts';
import { listOf } from './layout-model.ts';

/** A place a list may hold. */
export interface PlaceSource {
  /** The name saved in the layout. */
  readonly id: string;
  readonly label: string;
  /** Its icon name, when it declares one (the nav places do). */
  readonly icon?: string;
  /** Other names a layout may spell it by (a screen's bare id, when no other plugin shares it). */
  readonly aliases?: readonly string[];
}

/** One row. */
export interface Place {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly hidden: boolean;
  /** Settings is the way back to every setting: it is always shown, so its switch is fixed. */
  readonly locked: boolean;
}

export type ListPath = 'nav.items' | 'top' | 'panels.ferret.side' | 'phone.nav.items' | 'phone.top';

/** `daemon-picker` → `Daemon picker`: the name a place has when nothing else names it. */
export const humanize = (id: string): string => {
  const bare = id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id;
  const words = bare.split('-').map(word => (word === 'mcp' ? 'MCP' : word));
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const LOCKED = 'settings';

/** The source a name stands for: its own id or an alias held by exactly one source. */
function resolve(name: string, sources: readonly PlaceSource[]): PlaceSource | undefined {
  const exact = sources.find(source => source.id === name);
  if (exact !== undefined) return exact;
  const byAlias = sources.filter(source => source.aliases?.includes(name) === true);
  return byAlias.length === 1 ? byAlias[0] : undefined;
}

/** The shell's own nav items (Daemons): the layout engine accepts them although the nav catalog does not offer them. */
const shellSource = (name: string): PlaceSource | undefined =>
  (SHELL_ITEMS.nav as readonly string[]).includes(name) ? { id: name, label: humanize(name) } : undefined;

const place = (source: PlaceSource, hidden: boolean): Place => ({
  id: source.id,
  label: source.label,
  ...(source.icon === undefined ? {} : { icon: source.icon }),
  hidden: hidden && source.id !== LOCKED,
  locked: source.id === LOCKED,
});

/** The navigation rows: the layout's order first, then every other installed place; hidden as the layout says. */
export function navPlaces(
  items: readonly string[],
  hidden: readonly string[] | undefined,
  sources: readonly PlaceSource[],
): readonly Place[] {
  const listed: PlaceSource[] = [];
  for (const name of items) {
    const source = resolve(name, sources) ?? shellSource(name);
    if (source !== undefined && !listed.some(have => have.id === source.id)) listed.push(source);
  }
  const rest = sources.filter(source => !listed.some(have => have.id === source.id));
  const hiddenIds = new Set(
    hidden === undefined
      ? rest.map(source => source.id)
      : hidden.flatMap(name => {
          const source = resolve(name, sources) ?? shellSource(name);
          return source === undefined ? [] : [source.id];
        }),
  );
  return [...listed, ...rest].map(source => place(source, hiddenIds.has(source.id)));
}

/** The rows of a list with no hidden key: the places it names in order, then the rest of the set, hidden. */
export function listedPlaces(listed: readonly string[], sources: readonly PlaceSource[]): readonly Place[] {
  const named: PlaceSource[] = [];
  for (const name of listed) {
    const source = resolve(name, sources) ?? { id: name, label: humanize(name) };
    if (!named.some(have => have.id === source.id)) named.push(source);
  }
  const rest = sources.filter(source => !named.some(have => have.id === source.id));
  return [...named.map(source => place(source, false)), ...rest.map(source => place(source, true))];
}

/** The place sources a layout's nav falls back to outside a shell: the names it already holds. */
export function sourcesFromNames(names: readonly string[]): readonly PlaceSource[] {
  return [...new Set(names)].map(id => ({ id, label: humanize(id) }));
}

const isNav = (path: ListPath): path is 'nav.items' | 'phone.nav.items' =>
  path === 'nav.items' || path === 'phone.nav.items';

/** The hidden key that goes with a nav items key. */
const hiddenPathOf = (path: 'nav.items' | 'phone.nav.items'): 'nav.hidden' | 'phone.nav.hidden' =>
  path === 'nav.items' ? 'nav.hidden' : 'phone.nav.hidden';

/** The hidden list a layout holds for a nav items key (a phone list follows the wide one when it names none). */
export function hiddenOf(layout: Layout, path: 'nav.items' | 'phone.nav.items'): readonly string[] | undefined {
  return path === 'nav.items' ? layout.nav.hidden : (layout.phone?.nav?.hidden ?? layout.nav.hidden);
}

/**
 * A place the layout names that no row stands for, because it is not drawn here (Board while work is off): a nav name no
 * source stands for, or (any other list) a name in `absent`. Saving must carry it over, never drop it.
 */
function undisplayed(
  path: ListPath,
  name: string,
  sources: readonly PlaceSource[],
  absent: ReadonlySet<string>,
): boolean {
  return isNav(path) ? resolve(name, sources) === undefined && shellSource(name) === undefined : absent.has(name);
}

const NONE: ReadonlySet<string> = new Set();

/** The rows of one list key, from the layout and the set of places that key may hold; `absent` names places not drawn here. */
export function placesOf(
  layout: Layout,
  path: ListPath,
  sources: readonly PlaceSource[],
  absent: ReadonlySet<string> = NONE,
): readonly Place[] {
  if (isNav(path)) return navPlaces(listOf(layout, path), hiddenOf(layout, path), sources);
  return listedPlaces(listOf(layout, path), sources).filter(row => !absent.has(row.id));
}

export interface Change {
  readonly path: string;
  readonly value: string;
}

/** The layout the rows were read from and what it could show: what a save carries over of the places not shown. */
export interface Held {
  readonly layout: Layout;
  readonly sources: readonly PlaceSource[];
  /** Places of a non-nav list that are not drawn here (a panel of a plugin that is off). */
  readonly absent?: ReadonlySet<string>;
}

/**
 * The keys to save for these rows, as the comma lists `fy layout set` takes; one change set, so it saves whole. With
 * `held`, a place the layout names but no row stands for (switched off, so not offered) is carried over: it keeps its
 * place in the list (right after the row it followed) and, in a nav, stays in `hidden`, so turning it on finds it as it was.
 */
export function changesOf(path: ListPath, rows: readonly Place[], held?: Held): readonly Change[] {
  const absent = held?.absent ?? NONE;
  const items = rows.filter(row => isNav(path) || !row.hidden).map(row => row.id);
  const hidden = rows.filter(row => row.hidden).map(row => row.id);
  if (held !== undefined) {
    let anchor: string | undefined;
    for (const name of listOf(held.layout, path)) {
      if (!undisplayed(path, name, held.sources, absent)) {
        // A place switched off in this save (it left `items`) cannot be what the next one follows: keep the last one still there.
        const shown = isNav(path) ? (resolve(name, held.sources)?.id ?? name) : name;
        if (items.includes(shown)) anchor = shown;
        continue;
      }
      if (items.includes(name)) continue;
      items.splice(anchor === undefined ? 0 : items.indexOf(anchor) + 1, 0, name);
      anchor = name;
    }
    if (isNav(path))
      for (const name of hiddenOf(held.layout, path) ?? [])
        if (undisplayed(path, name, held.sources, absent) && !hidden.includes(name)) hidden.push(name);
  }
  if (!isNav(path)) return [{ path, value: items.join(',') }];
  return [
    { path, value: items.join(',') },
    { path: hiddenPathOf(path), value: hidden.join(',') },
  ];
}

/**
 * What a wide-nav edit must also write so the phone bar keeps showing what it showed: a phone list that names its own
 * items but no `hidden` inherits the wide `hidden`, so a new wide `hidden` would change the phone. Writes the phone's
 * current hidden set beside its explicit items. Nothing is added for any other key or a phone that names its own.
 */
export function keepPhoneNav(
  layout: Layout,
  path: ListPath,
  sources: readonly PlaceSource[],
  changes: readonly Change[],
): readonly Change[] {
  const phone = layout.phone?.nav;
  if (path !== 'nav.items' || phone?.items === undefined || phone.hidden !== undefined) return changes;
  const keep = placesOf(layout, 'phone.nav.items', sources)
    .filter(row => row.hidden)
    .map(row => row.id);
  // A place not shown here (Board while work is off) stays hidden on the phone too.
  for (const name of hiddenOf(layout, 'phone.nav.items') ?? [])
    if (undisplayed('phone.nav.items', name, sources, NONE) && !keep.includes(name)) keep.push(name);
  return [...changes, { path: 'phone.nav.hidden', value: keep.join(',') }];
}

/** The rows with one place switched on or off; Settings stays on. */
export const withHidden = (rows: readonly Place[], id: string, hidden: boolean): readonly Place[] =>
  rows.map(row => (row.id === id && !row.locked ? { ...row, hidden } : row));

/** The nav places as the list rows know them: the qualified name, and the bare screen id when it is unambiguous. */
export function navSources(items: readonly NavCatalogItem[]): readonly PlaceSource[] {
  const bare = (item: NavCatalogItem): string | undefined =>
    item.entry.kind === 'screen' ? item.entry.screen.id : undefined;
  return items.map(item => {
    const alias = bare(item);
    const unique =
      alias !== undefined && alias !== item.id && items.filter(other => bare(other) === alias).length === 1;
    return {
      id: item.id,
      label: item.label,
      ...(item.icon === undefined ? {} : { icon: item.icon }),
      ...(unique ? { aliases: [alias] } : {}),
    };
  });
}
