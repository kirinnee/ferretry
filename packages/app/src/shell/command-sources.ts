import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ShellAppImplementation } from '../connect/provides.ts';
import type { ScreenHrefOf } from '../router/screen-href.ts';
import type { SurfaceEntry } from '../surfaces/registry.ts';
import { daemonTitle, type PairedDaemon } from '../daemons/daemon-list.ts';
import type { ScreenRef } from '../layout/engine.ts';
import type { DeviceLayoutStore } from '../layout/device-layout.ts';
import type { Layout } from '../layout/layout.ts';
import {
  DEVICE_SETTINGS_HREF,
  daemonHomeHref,
  daemonSettingsHref,
  needsSubject,
  type RouteTable,
} from '../router/routes.ts';
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

/**
 * Where the shell's own places sit among the nav's: after every plugin screen (the nav's `order`s stop well short of
 * it), as v4's list ended on Settings.
 */
const SHELL_ORDER = 1000;

/** v4's "Open settings" (`SETTINGS_DESTINATION`): its label, its sentence and the words it was found by. */
const OPEN_SETTINGS = {
  label: 'Open settings',
  entry: {
    description: 'Appearance and behaviour on this browser, and every paired machine.',
    keywords: ['settings', 'preferences', 'options', 'appearance', 'behaviour', 'daemon', 'pairing', 'configure'],
    resting: true,
  },
} as const;

export function placeSource(input: PlaceSourceInput): CommandBarSource {
  // The caller may supply Map.values(), which is consumed once. Queries and reopenings reuse this source.
  const screens = [...input.screens];
  return () => {
    const entries: CommandBarEntry[] = [];
    const go = (id: string, label: string, href: string, extra: Partial<CommandBarEntry> = {}): void => {
      entries.push({ id, group: 'Go to', label, run: () => input.navigate(href), ...extra });
    };
    for (const paired of input.daemons) {
      const title = daemonTitle(paired);
      go(`daemon-${paired.daemon}`, title, daemonHomeHref(paired.daemon), {
        // The host name is the title when the machine has no name of its own: say it once.
        ...(paired.machine === title ? {} : { description: paired.machine }),
        keywords: ['daemon', paired.machine],
        resting: true,
        order: SHELL_ORDER - 1,
      });
    }
    const seen = new Set<string>();
    for (const screen of screens) {
      const key = `${screen.plugin}.${screen.id}`;
      // A screen that needs a subject is not a destination on its own; a bare id also listed qualified is one place. Only
      // a screen the nav carries (it has a nav label) is a place: the rest are pages reached from one, and drew as the
      // plugin's own name, twice. The owning plugin says more about its places through `shell.commands`
      // ({@link destinationCommands}), under the same entry id, and that entry replaces this plain one.
      if (seen.has(key) || needsSubject(screen.path) || screen.navOrder === undefined) continue;
      seen.add(key);
      const daemonLess = screen.path.startsWith('/');
      if (!daemonLess && input.daemon === undefined) continue;
      const href = daemonLess ? input.routes.href(screen, {}) : input.routes.href(screen, {}, input.daemon as string);
      go(`screen-${key}`, screen.label, href, {
        keywords: [screen.id, screen.plugin],
        resting: true,
        order: screen.navOrder,
      });
    }
    // Settings are offered at rest too, as v4's palette did: the bar never opens empty, even with no machine paired.
    // "Open settings" is v4's entry (S-0520), with its wording. v4 had one Settings page; 5.0 has this device's and each
    // machine's, so with a machine on screen "Open settings" opens that machine's and this device's has its own row;
    // with none it opens this device's, the one place there is.
    if (input.daemon !== undefined) {
      go('daemon-settings', OPEN_SETTINGS.label, daemonSettingsHref(input.daemon), {
        ...OPEN_SETTINGS.entry,
        keywords: [...OPEN_SETTINGS.entry.keywords, 'plugins'],
        order: SHELL_ORDER,
      });
      go('device-settings', 'This device’s settings', DEVICE_SETTINGS_HREF, {
        description: 'Appearance, density and what this device remembers',
        keywords: ['theme', 'appearance', 'density', 'settings', 'preferences'],
        resting: true,
        order: SHELL_ORDER + 1,
      });
    } else {
      go('device-settings', OPEN_SETTINGS.label, DEVICE_SETTINGS_HREF, {
        ...OPEN_SETTINGS.entry,
        keywords: [...OPEN_SETTINGS.entry.keywords, 'theme'],
        order: SHELL_ORDER,
      });
    }
    return entries;
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
  /**
   * The ferret whose page the reader is on (the `:ferret` of the screen on show), or `undefined` anywhere else. A source
   * that offers something about "this ferret" (the Board narrowed to it) is offered only with one.
   */
  readonly ferret?: string;
  /** Asks the bar to list again: an answer the source was waiting for has arrived. */
  readonly changed: () => void;
}

/**
 * A plugin's contribution to the command bar (its app half's `shell.commands`, see `provideToShell`). It is built once
 * per daemon the bar opens on (it may answer several sources: its places and its search) and asked for its entries on
 * every keystroke, like the shell's own sources; a source
 * that reads its daemon answers what it already holds and calls `changed` when more arrives.
 */
export type PluginCommandSource = (context: PluginCommandContext) => CommandBarSource | readonly CommandBarSource[];

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

const isSourceList = (built: CommandBarSource | readonly CommandBarSource[]): built is readonly CommandBarSource[] =>
  Array.isArray(built);

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
  readonly ferret?: string | undefined;
}): readonly CommandBarSource[] {
  return pluginCommandSources(input.surfaces).flatMap(({ plugin, source }) => {
    const client = input.clientOf(plugin);
    if (client === undefined) return [];
    try {
      const built = source({
        client,
        daemon: input.daemon,
        navigate: input.navigate,
        screenHref: input.screenHref,
        changed: input.changed,
        ...(input.ferret === undefined ? {} : { ferret: input.ferret }),
      });
      return isSourceList(built) ? built : [built];
    } catch {
      return [];
    }
  });
}

// ─── a plugin's places ────────────────────────────────────────────────────────────────────────────────────────────

/** One place a plugin offers under "Go to": a screen of its own, with the words v4's palette said it in. */
export interface DestinationDecl {
  readonly screen: string;
  readonly label: string;
  /** One line saying what is there, as the top bar's tooltip did in v4. */
  readonly description: string;
  /** The words it is found by besides its label and description. */
  readonly keywords?: readonly string[];
  /** Fills a screen path's parameters (`{ tab: 'shared' }` for `sharing/:tab?`). */
  readonly params?: Readonly<Record<string, string>>;
  /** Its place in the list: the nav's own `order` for that screen, so the bar and the nav agree. */
  readonly order: number;
  /** The entry id when the screen is offered more than once (a tab of it); default `screen-<plugin>.<screen>`. */
  readonly id?: string;
}

/**
 * A plugin's places for the bar, as its `shell.commands`: each screen once, under "Go to", with its description, at the
 * address the shell's route table gives it. A screen no installed plugin draws, or one that cannot be addressed from
 * these parameters, is left out. The entry id is the shell's own for a nav screen, so this entry replaces the shell's
 * plain one rather than joining it.
 */
export const destinationCommands =
  (plugin: string, destinations: readonly DestinationDecl[]) =>
  (context: PluginCommandContext) =>
  (): readonly CommandBarEntry[] =>
    destinations.flatMap(destination => {
      const href = context.screenHref(context.daemon, plugin, destination.screen, destination.params);
      if (href === undefined) return [];
      return [
        {
          id: destination.id ?? `screen-${plugin}.${destination.screen}`,
          group: 'Go to',
          label: destination.label,
          description: destination.description,
          keywords: [destination.screen, plugin, ...(destination.keywords ?? [])],
          resting: true,
          order: destination.order,
          run: () => context.navigate(href),
        },
      ];
    });
