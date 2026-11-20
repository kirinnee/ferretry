import type { SurfaceEntry } from '../surfaces/registry.ts';
import type { InstalledViews, ResolvedLayout } from './layout.ts';
import { SHELL_ITEMS } from './slots.ts';

/**
 * THE LAYOUT ENGINE (§5.1): a layout (data) + the installed views (from the compiled manifests) → a frame plan the
 * shell draws. Pure. Which of those views may RUN on a given daemon is the client guard's question, asked at render
 * time; the plan says only where each view goes.
 */

export interface ScreenRef {
  readonly plugin: string;
  readonly id: string;
  /** The screen's path under `/d/<daemon>/` (relative) or from the root (absolute, a daemon-less screen). */
  readonly path: string;
  readonly label: string;
  readonly icon?: string;
  readonly navOrder?: number;
  /** `none`: drawn without the shell's chrome (`ScreenDecl.chrome`). */
  readonly chrome?: 'none';
}

export interface PanelRef {
  readonly plugin: string;
  readonly id: string;
  readonly slot: string;
  readonly order: number;
}

export interface Views {
  /** By name: the qualified `plugin.id` always, and the bare `id` when no other plugin declares the same one. */
  readonly screens: ReadonlyMap<string, ScreenRef>;
  readonly panels: ReadonlyMap<string, readonly PanelRef[]>;
  readonly installed: InstalledViews;
}

export function viewsOf(surfaces: readonly SurfaceEntry[]): Views {
  const screens = new Map<string, ScreenRef>();
  const bare = new Map<string, ScreenRef[]>();
  const panels = new Map<string, PanelRef[]>();
  for (const entry of surfaces) {
    const ui = entry.manifest.ui;
    for (const screen of ui?.screens ?? []) {
      const ref: ScreenRef = {
        plugin: entry.id,
        id: screen.id,
        path: screen.path,
        label: screen.nav?.label ?? entry.title,
        ...(screen.nav?.icon === undefined ? {} : { icon: screen.nav.icon }),
        ...(screen.nav === undefined ? {} : { navOrder: screen.nav.order }),
        ...(screen.chrome === undefined ? {} : { chrome: screen.chrome }),
      };
      screens.set(`${entry.id}.${screen.id}`, ref);
      bare.set(screen.id, [...(bare.get(screen.id) ?? []), ref]);
    }
    for (const panel of ui?.panels ?? []) {
      const list = panels.get(panel.slot) ?? [];
      list.push({ plugin: entry.id, id: panel.id, slot: panel.slot, order: panel.order });
      panels.set(panel.slot, list);
    }
  }
  for (const [id, refs] of bare) {
    const only = refs[0];
    if (refs.length === 1 && only !== undefined && !screens.has(id)) screens.set(id, only);
  }
  for (const list of panels.values()) list.sort((a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin));
  return {
    screens,
    panels,
    installed: {
      screens: new Set(screens.keys()),
      panels: new Map([...panels].map(([slot, list]) => [slot, new Set(list.map(p => p.id))])),
    },
  };
}

export type NavEntry =
  | { readonly kind: 'screen'; readonly screen: ScreenRef }
  | { readonly kind: 'shell'; readonly item: (typeof SHELL_ITEMS.nav)[number] };

export type SideHolds =
  | { readonly kind: 'none' }
  | { readonly kind: 'panels' }
  | { readonly kind: 'screen'; readonly screen: ScreenRef };

export interface FramePlan {
  readonly layoutId: string;
  readonly nav: {
    readonly side: ResolvedLayout['nav']['side'];
    readonly style: ResolvedLayout['nav']['style'];
    readonly labels: ResolvedLayout['nav']['labels'];
    readonly entries: readonly NavEntry[];
  };
  readonly top: readonly string[];
  readonly side: {
    readonly show: ResolvedLayout['side']['show'];
    readonly holds: SideHolds;
    /** The edge the column sits on; a layout that names none keeps it on the right. */
    readonly at: 'left' | 'right';
  };
  readonly density: ResolvedLayout['density'];
  /** The panels a slot shows, in order. */
  panels(slot: string): readonly PanelRef[];
}

/** The shell item the catalog offers: Settings is a place every layout may keep, hide or move. */
const CATALOG_SHELL: readonly (typeof SHELL_ITEMS.nav)[number][] = ['settings'];

const keyOf = (entry: NavEntry): string =>
  entry.kind === 'shell' ? entry.item : `${entry.screen.plugin}.${entry.screen.id}`;

/**
 * Every place a nav can show, in the order a nav with no opinion lists them: each installed screen that declares a nav
 * entry, by its declared order, then the shell's own Settings. One entry per screen, however many names reach it.
 */
export function navCatalogEntries(views: Views): readonly NavEntry[] {
  const seen = new Set<ScreenRef>();
  const screens: ScreenRef[] = [];
  for (const screen of views.screens.values()) {
    if (screen.navOrder === undefined || seen.has(screen)) continue;
    seen.add(screen);
    screens.push(screen);
  }
  screens.sort(
    (a, b) => (a.navOrder ?? 0) - (b.navOrder ?? 0) || `${a.plugin}.${a.id}`.localeCompare(`${b.plugin}.${b.id}`),
  );
  return [
    ...screens.map((screen): NavEntry => ({ kind: 'screen', screen })),
    ...CATALOG_SHELL.map((item): NavEntry => ({ kind: 'shell', item })),
  ];
}

/**
 * The nav's entries. A layout that never names `hidden` lists exactly its `items` (as layouts did before the field). One
 * that names it (even empty) gives `items` as an ORDER: those places first, then every other installed nav place by its
 * declared order, minus whatever is hidden, so a plugin installed later shows up without anyone editing the layout.
 * A name that resolves to nothing installed is skipped. Settings is never hidden: naming it in `hidden` is ignored.
 */
function navEntries(nav: ResolvedLayout['nav'], views: Views): readonly NavEntry[] {
  const shellNav: readonly string[] = SHELL_ITEMS.nav;
  const listed: NavEntry[] = [];
  for (const item of nav.items) {
    if (shellNav.includes(item)) listed.push({ kind: 'shell', item: item as (typeof SHELL_ITEMS.nav)[number] });
    else {
      const screen = views.screens.get(item);
      if (screen !== undefined) listed.push({ kind: 'screen', screen });
    }
  }
  if (nav.hidden === undefined) return listed;
  const hidden = new Set<string>();
  for (const name of nav.hidden) {
    // Settings is the way back to every other setting, so no layout can hide it.
    if (name === 'settings') continue;
    if (shellNav.includes(name)) hidden.add(name);
    else {
      const screen = views.screens.get(name);
      if (screen !== undefined) hidden.add(`${screen.plugin}.${screen.id}`);
    }
  }
  const placed = new Set<string>();
  const out: NavEntry[] = [];
  for (const entry of [...listed, ...navCatalogEntries(views)]) {
    const key = keyOf(entry);
    if (hidden.has(key) || placed.has(key)) continue;
    placed.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Places the views. A slot the layout lists shows exactly those panels in that order; a slot it does not list shows
 * every panel declared for it, by declared order. Names were checked by `checkLayout` before; any that still do not
 * resolve are skipped rather than drawn broken.
 */
export function planFrame(layout: ResolvedLayout, views: Views): FramePlan {
  const entries = navEntries(layout.nav, views);
  const holds = layout.side.holds;
  const sideScreen = views.screens.get(holds);
  const side: SideHolds =
    holds === 'none'
      ? { kind: 'none' }
      : holds === 'panels'
        ? { kind: 'panels' }
        : sideScreen === undefined
          ? { kind: 'none' }
          : { kind: 'screen', screen: sideScreen };
  const chosen = new Map<string, readonly PanelRef[]>();
  for (const [slot, ids] of Object.entries(layout.panels)) {
    const declared = views.panels.get(slot) ?? [];
    chosen.set(
      slot,
      ids.flatMap(id => declared.filter(panel => panel.id === id)),
    );
  }
  return {
    layoutId: layout.id,
    nav: { side: layout.nav.side, style: layout.nav.style, labels: layout.nav.labels, entries },
    top: layout.top,
    side: { show: layout.side.show, holds: side, at: layout.side.at ?? 'right' },
    density: layout.density,
    panels: slot => chosen.get(slot) ?? views.panels.get(slot) ?? [],
  };
}
