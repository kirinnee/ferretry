import { useMemo } from 'react';
import { useShell } from '../shell/context.tsx';
import { navIconName } from '../shell/icons.tsx';
import { type NavEntry, navCatalogEntries, viewsOf } from './engine.ts';

/**
 * THE FIXED SET OF PLACES A NAV CAN SHOW: what the Layout tab lists to reorder and hide, so nobody types a name. It is
 * the same set the frame plan appends for a layout that names `hidden`, so a row here is a place the nav can draw.
 */
export interface NavCatalogItem {
  /** The name a layout lists it by (`items`, `hidden`): the qualified `plugin.id`, or the shell item's own name. */
  readonly id: string;
  readonly label: string;
  /** Its icon name (`icons.tsx`), when it declares one. */
  readonly icon: string | undefined;
  /** Where it sits when a layout has no opinion. */
  readonly order: number;
  readonly entry: NavEntry;
}

/** Shell items sit after every plugin screen. */
const SHELL_ORDER = 1000;

/** The catalog of a set of nav entries, in their order. Pure. */
export function navCatalogItems(entries: readonly NavEntry[]): readonly NavCatalogItem[] {
  return entries.map((entry, index): NavCatalogItem => {
    if (entry.kind === 'shell')
      return {
        id: entry.item,
        label: entry.item === 'settings' ? 'Settings' : 'Daemons',
        icon: navIconName(entry),
        order: SHELL_ORDER + index,
        entry,
      };
    return {
      id: `${entry.screen.plugin}.${entry.screen.id}`,
      label: entry.screen.label,
      icon: entry.screen.icon,
      order: entry.screen.navOrder ?? index,
      entry,
    };
  });
}

/**
 * The panels of `slot` that are compiled in but not offered, because every paired machine has their plugin turned off:
 * the Layout tab draws no control for them (a saved layout still names them, and a save keeps them).
 */
export function useAbsentPanels(slot: string): ReadonlySet<string> {
  const { runtime, views } = useShell();
  return useMemo(() => {
    const offered = new Set((views.panels.get(slot) ?? []).map(panel => panel.id));
    return new Set(
      (viewsOf(runtime.surfaces).panels.get(slot) ?? []).map(panel => panel.id).filter(id => !offered.has(id)),
    );
  }, [runtime, views, slot]);
}

/** The installed nav places (screens that declare a nav entry, and Settings), label and icon and default order. */
export function useNavCatalog(): readonly NavCatalogItem[] {
  const { views } = useShell();
  return useMemo(() => navCatalogItems(navCatalogEntries(views)), [views]);
}
