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
    readonly entries: readonly NavEntry[];
  };
  readonly top: readonly string[];
  readonly side: { readonly show: ResolvedLayout['side']['show']; readonly holds: SideHolds };
  readonly density: ResolvedLayout['density'];
  /** The panels a slot shows, in order. */
  panels(slot: string): readonly PanelRef[];
}

/**
 * Places the views. A slot the layout lists shows exactly those panels in that order; a slot it does not list shows
 * every panel declared for it, by declared order. Names were checked by `checkLayout` before; any that still do not
 * resolve are skipped rather than drawn broken.
 */
export function planFrame(layout: ResolvedLayout, views: Views): FramePlan {
  const shellNav: readonly string[] = SHELL_ITEMS.nav;
  const entries: NavEntry[] = [];
  for (const item of layout.nav.items) {
    if (shellNav.includes(item)) entries.push({ kind: 'shell', item: item as (typeof SHELL_ITEMS.nav)[number] });
    else {
      const screen = views.screens.get(item);
      if (screen !== undefined) entries.push({ kind: 'screen', screen });
    }
  }
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
    nav: { side: layout.nav.side, style: layout.nav.style, entries },
    top: layout.top,
    side: { show: layout.side.show, holds: side },
    density: layout.density,
    panels: slot => chosen.get(slot) ?? views.panels.get(slot) ?? [],
  };
}
