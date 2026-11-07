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
    for (const screen of input.screens) {
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
