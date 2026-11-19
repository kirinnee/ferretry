import type { ReactNode } from 'react';
import { ShellContext, type ShellModel } from '../shell/context.tsx';

/** One panel a suite places in a slot: the plugin and id it is declared under, and what it draws (its props in). */
export interface PlacedPanel {
  readonly plugin: string;
  readonly id: string;
  readonly view: (props: Record<string, unknown>) => ReactNode;
}

/**
 * A shell that places the given panels in the given slots and nothing else, for a suite that mounts a page which OFFERS
 * a slot (`PanelSlot`, `useSlotHasPanels`) and must see the panels a contributing plugin draws there. Each panel is
 * drawn by the shell's own `PluginView` path: the page's props and `subject` go in, the panel's `view` comes out. A
 * slot not named here has no panel, exactly as in a layout that places none. Use it only for that.
 */
export function WithSlotPanels({
  slots,
  blocked = {},
  children,
}: {
  readonly slots: Readonly<Record<string, readonly PlacedPanel[]>>;
  /** Plugins the shell reports blocked on every daemon, by the one line it would show (`blockedLine`); default none. */
  readonly blocked?: Readonly<Record<string, string>>;
  readonly children: ReactNode;
}) {
  const everyPanel = Object.values(slots).flat();
  const shell = {
    runtime: {
      // A page mounted in these slots may read an app hook; no plugin here provides one.
      appHook: (): unknown => undefined,
      subscribe: () => () => undefined,
      version: () => 0,
      titleOf: (plugin: string) => plugin,
      blockedLine: (_daemon: string, plugin: string) => blocked[plugin],
      reach: () => ({}),
      place: () => null,
      half: (_daemon: string, plugin: string) => ({
        kind: 'ready',
        panels: Object.fromEntries(
          everyPanel.filter(panel => panel.plugin === plugin).map(panel => [panel.id, panel.view]),
        ),
      }),
    },
    // No installed screens: a page that also asks for another plugin's screen address (`useScreenHref`) is answered `undefined`.
    views: { screens: new Map() },
    routes: { href: () => undefined },
    plan: {
      panels: (slot: string) =>
        (slots[slot] ?? []).map((panel, order) => ({ plugin: panel.plugin, id: panel.id, slot, order })),
    },
  } as unknown as ShellModel;
  return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
}
