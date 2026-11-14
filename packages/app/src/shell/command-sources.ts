import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ShellAppImplementation } from '../connect/provides.ts';
import type { ScreenHrefOf } from '../router/screen-href.ts';
import type { SurfaceEntry } from '../surfaces/registry.ts';
import { daemonTitle, type PairedDaemon } from '../daemons/daemon-list.ts';
import type { ScreenRef } from '../layout/engine.ts';
import type { DeviceLayoutStore } from '../layout/device-layout.ts';
import type { Layout } from '../layout/layout.ts';
import { DEVICE_SETTINGS_HREF, daemonHomeHref, daemonSettingsHref, type RouteTable } from '../router/routes.ts';
import type { CommandBarEntry, CommandBarSource } from '../ui/command-bar-model.ts';

/**
 * THE SHELL'S OWN COMMAND BAR ENTRIES: places (each daemon, the screens the nav can open, settings) and this device's
 * layout commands — the app's side of `fy layout set --device` (§5.3). Nothing here is a feature; plugin entries are
 * contributed later through the same {@link CommandBarSource} shape.
 */

export interface PlaceSourceInput {
  readonly daemons: readonly PairedDaemon[];
  /** The daemon the reader is on, whose screens are offered. */
  readonly daemon: string | undefined;
  readonly screens: Iterable<ScreenRef>;
  readonly routes: RouteTable;
  readonly navigate: (href: string) => void;
}

export function placeSource(input: PlaceSourceInput): CommandBarSource {
  // The caller may supply Map.values(), which is consumed once. Queries and reopenings reuse this source.
  const screens = [...input.screens];
  return () => {
    const entries: CommandBarEntry[] = [];
    const go = (id: string, label: string, href: string, extra: Partial<CommandBarEntry> = {}): void => {
      entries.push({ id, group: 'Go to', label, run: () => input.navigate(href), ...extra });
    };
    for (const paired of input.daemons) {
      go(`daemon-${paired.daemon}`, daemonTitle(paired), daemonHomeHref(paired.daemon), {
        description: paired.machine,
        keywords: ['daemon', paired.machine],
        resting: true,
      });
    }
    const seen = new Set<string>();
    for (const screen of screens) {
      const key = `${screen.plugin}.${screen.id}`;
      // A screen that needs a subject is not a destination on its own; a bare id also listed qualified is one place.
      if (seen.has(key) || screen.path.includes(':')) continue;
      seen.add(key);
      const daemonLess = screen.path.startsWith('/');
      if (!daemonLess && input.daemon === undefined) continue;
      const href = daemonLess ? input.routes.href(screen, {}) : input.routes.href(screen, {}, input.daemon as string);
      go(`screen-${key}`, screen.label, href, { keywords: [screen.id, screen.plugin], resting: true });
    }
    go('device-settings', 'This device’s settings', DEVICE_SETTINGS_HREF, { keywords: ['theme', 'appearance'] });
    if (input.daemon !== undefined) {
      go('daemon-settings', 'This daemon’s settings', daemonSettingsHref(input.daemon), { keywords: ['plugins'] });
    }
    return entries;
  };
}

export interface SettingsSourceInput {
  /** The daemon the reader is on; settings are saved on a daemon, so none means no entries. */
  readonly daemon: string | undefined;
  readonly surfaces: readonly SurfaceEntry[];
  readonly navigate: (href: string) => void;
}

/**
 * EVERY SETTINGS TAB AS A DESTINATION: the tabs the Settings page lists (one per `ui.settings` declaration of every
 * plugin), each found by its label, its plugin and the words it declares, and opening that tab on this daemon.
 */
export function settingsSource(input: SettingsSourceInput): (query: string) => readonly CommandBarEntry[] {
  return () => {
    if (input.daemon === undefined) return [];
    const daemon = input.daemon;
    return input.surfaces
      .flatMap(entry => (entry.manifest.ui?.settings ?? []).map(tab => ({ plugin: entry.id, tab })))
      .sort((a, b) => a.tab.order - b.tab.order || a.plugin.localeCompare(b.plugin))
      .map(({ plugin, tab }) => ({
        id: `settings-${plugin}.${tab.id}`,
        group: 'Settings',
        label: tab.label,
        description: 'Settings',
        keywords: ['settings', plugin, tab.id, ...(tab.keywords ?? [])],
        run: () => input.navigate(daemonSettingsHref(daemon, plugin, tab.id)),
      }));
  };
}

/** `layout set --device …` and `layout reset --device`, applied over the layout in force on this device. */
export function deviceLayoutSource(base: Layout, layouts: DeviceLayoutStore): CommandBarSource {
  return () => {
    const entries: CommandBarEntry[] = [];
    const set = (path: string, value: string, label: string, keywords: readonly string[]): void => {
      entries.push({
        id: `layout-${path}-${value}`,
        group: 'Layout on this device',
        label,
        description: `layout set --device ${path} ${value}`,
        keywords: ['layout', ...keywords],
        run: () => void layouts.set(base, path, value),
      });
    };
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      set('nav.side', side, `Move the navigation to the ${side}`, ['sidebar', 'nav', side]);
    }
    set('density', 'compact', 'Use the compact density', ['dense', 'compact']);
    set('density', 'comfortable', 'Use the comfortable density', ['comfortable', 'roomy']);
    entries.push({
      id: 'layout-reset-device',
      group: 'Layout on this device',
      label: 'Follow the owner’s layout on this device',
      description: 'layout reset --device',
      keywords: ['layout', 'reset', 'owner'],
      run: () => layouts.reset(),
    });
    return entries;
  };
}

// ─── plugins' entries ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the shell hands a plugin's command bar source for the daemon the reader is on. */
export interface PluginCommandContext {
  /** That plugin's guarded client for this daemon. */
  readonly client: PluginClient;
  readonly daemon: string;
  readonly navigate: (href: string) => void;
  /** Where another plugin's screen lives (`useScreenHref`'s answer), so no plugin hard-codes a URL. */
  readonly screenHref: ScreenHrefOf;
  /** Asks the bar to list again: an answer the source was waiting for has arrived. */
  readonly changed: () => void;
}

/**
 * A plugin's contribution to the command bar (its app half's `shell.commands`, see `provideToShell`). It is built once
 * per daemon the bar opens on and asked for its entries on every keystroke, like the shell's own sources; a source
 * that reads its daemon answers what it already holds and calls `changed` when more arrives.
 */
export type PluginCommandSource = (context: PluginCommandContext) => CommandBarSource;

/** The halves in the registry that contribute command bar entries, with their plugin id. */
export function pluginCommandSources(
  surfaces: readonly SurfaceEntry[],
): readonly { readonly plugin: string; readonly source: PluginCommandSource }[] {
  return surfaces.flatMap(entry => {
    const half = entry.app as Partial<ShellAppImplementation> | undefined;
    if (half === undefined || half.skeleton === true) return [];
    const source = half.shell?.commands;
    return typeof source === 'function' ? [{ plugin: entry.id, source }] : [];
  });
}

/**
 * Builds the plugins' sources for one daemon, each over that plugin's own guarded client. A plugin with no client
 * there (paused, blocked, not reached) lists nothing, and one whose source throws while building costs only its own
 * entries.
 */
export function buildPluginCommandSources(input: {
  readonly surfaces: readonly SurfaceEntry[];
  readonly daemon: string;
  readonly clientOf: (plugin: string) => PluginClient | undefined;
  readonly navigate: (href: string) => void;
  readonly screenHref: ScreenHrefOf;
  readonly changed: () => void;
}): readonly CommandBarSource[] {
  return pluginCommandSources(input.surfaces).flatMap(({ plugin, source }) => {
    const client = input.clientOf(plugin);
    if (client === undefined) return [];
    try {
      return [
        source({
          client,
          daemon: input.daemon,
          navigate: input.navigate,
          screenHref: input.screenHref,
          changed: input.changed,
        }),
      ];
    } catch {
      return [];
    }
  });
}
