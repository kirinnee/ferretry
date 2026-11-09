/**
 * `shell-provides` (shell contract §2): what an app half hands the shell through `provideToShell` that the shell would
 * otherwise drop or mishandle in silence. This file holds the S3 rules — the declared address fragments and the device
 * views that take them (S3), and the frame's own sections (S4, S5, S7); each later shell item adds its own rules here.
 *
 *   - a keyed fragment key claimed by two plugins (or twice by one) fails, `strip: false` claims included: the shell
 *     would hand one link to two takers, or strip a key another plugin keeps in the address;
 *   - a keyed key outside the grammar (`FRAGMENT_KEY`) fails;
 *   - a path declaration on a screen the plugin does not declare, or on one that is not daemon-less, fails;
 *   - a stripping keyed declaration with no `device` view fails: the shell would strip a link nothing can take;
 *   - a `device` view on a skeleton half fails: a half that implements nothing has no view to mount;
 *   - a declaration in no known form fails;
 *   - a `links` provider outside `LINK_TAKERS` fails (S7): where a link opens is Browsers';
 *   - a `navBadges` key that is not one of the plugin's own screens with a `nav` entry fails (S4);
 *   - a `deviceSettings` key that is not a panel the plugin declares in `device.settings` fails, and so does a
 *     `device.settings` panel with no `deviceSettings` view; the same for `navPanels` and the `nav` slot (S4, MJ3);
 *   - a `background` or `navBadges` entry on a skeleton half fails: nothing mounts it (S5, S4).
 */
import { LINK_TAKERS } from '../../packages/app/src/connect/provides.ts';
import { FRAGMENT_KEY } from '../../packages/app/src/router/address.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { loadHalf } from '../gen/lib/workspace.ts';

/** One plugin's app half, as this check reads it. */
export interface ShellProvidesHalf {
  readonly plugin: string;
  readonly skeleton: boolean;
  /** The screens the plugin's manifest declares. */
  readonly screens: readonly { readonly id: string; readonly daemonless?: boolean; readonly nav?: unknown }[];
  /** The panels the plugin's manifest declares, with their slot. */
  readonly panels?: readonly { readonly id: string; readonly slot: string }[];
  /** `shell.fragments`, as written (unchecked). */
  readonly fragments: readonly unknown[];
  /** The names of `shell.device`'s views. */
  readonly device: readonly string[];
  /** The names of `shell.background`'s views (S5). */
  readonly background?: readonly string[];
  /** The names of `shell.deviceSettings`'s and `shell.navPanels`'s views, and `shell.navBadges`' keys (S4). */
  readonly deviceSettings?: readonly string[];
  readonly navPanels?: readonly string[];
  readonly navBadges?: readonly string[];
  /** Whether the half provides `shell.links` (S7). */
  readonly links?: boolean;
}

/** The two device-level slots, the `shell` section that holds their views, and what a missing view is called. */
const DEVICE_SLOTS = [
  { slot: 'device.settings', section: 'deviceSettings' },
  { slot: 'nav', section: 'navPanels' },
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The S4, S5 and S7 rules for one half. */
function shellSectionFindings(half: ShellProvidesHalf, add: (where: string, message: string) => number): void {
  const panels = half.panels ?? [];
  if (half.links === true && !LINK_TAKERS.includes(half.plugin))
    add(
      half.plugin,
      `provides \`shell.links\`, but only ${LINK_TAKERS.join(', ')} may: where a link opens is not this plugin's`,
    );
  for (const key of half.navBadges ?? []) {
    const screen = half.screens.find(each => each.id === key);
    if (screen === undefined)
      add(half.plugin, `has a \`shell.navBadges\` key "${key}", which is not one of its own screens`);
    else if (screen.nav === undefined)
      add(
        half.plugin,
        `has a \`shell.navBadges\` key "${key}", whose screen declares no \`nav\` entry: nothing draws the badge`,
      );
  }
  for (const { slot, section } of DEVICE_SLOTS) {
    const declared = new Set(panels.filter(panel => panel.slot === slot).map(panel => panel.id));
    const provided = new Set(half[section] ?? []);
    for (const key of provided)
      if (!declared.has(key))
        add(half.plugin, `has a \`shell.${section}\` view "${key}", which is not a panel it declares in \`${slot}\``);
    if (!half.skeleton)
      for (const id of declared)
        if (!provided.has(id))
          add(
            half.plugin,
            `declares the \`${slot}\` panel "${id}" with no \`shell.${section}\` view: a \`${slot}\` panel is drawn with no daemon, so a per-daemon \`panels\` view is never drawn`,
          );
  }
  if (half.skeleton) {
    const background = half.background ?? [];
    if (background.length > 0)
      add(
        half.plugin,
        `is a skeleton half with \`shell.background\` views (${background.join(', ')}): nothing mounts them`,
      );
    const badges = half.navBadges ?? [];
    if (badges.length > 0)
      add(half.plugin, `is a skeleton half with \`shell.navBadges\` (${badges.join(', ')}): nothing draws them`);
  }
}

export function shellProvidesFindings(halves: readonly ShellProvidesHalf[]): Finding[] {
  const found: Finding[] = [];
  const add = (where: string, message: string): number => found.push({ check: 'shell-provides', where, message });
  const claims = new Map<string, string[]>();
  for (const half of halves) {
    for (const decl of half.fragments) {
      if (isRecord(decl) && decl.form === 'keyed' && typeof decl.key === 'string') {
        const key = decl.key;
        if (!FRAGMENT_KEY.test(key))
          add(half.plugin, `declares fragment key "${key}", which is not ${String(FRAGMENT_KEY)}`);
        claims.set(key, [...(claims.get(key) ?? []), half.plugin]);
        if (decl.strip !== false && half.device.length === 0)
          add(
            half.plugin,
            `declares the stripping fragment key "${key}" with no \`shell.device\` view: the shell would strip a link nothing takes`,
          );
      } else if (isRecord(decl) && decl.form === 'path' && typeof decl.screen === 'string') {
        const id = decl.screen;
        const screen = half.screens.find(each => each.id === id);
        if (screen === undefined)
          add(half.plugin, `declares a path fragment on screen "${id}", which its manifest does not declare`);
        else if (screen.daemonless !== true)
          add(half.plugin, `declares a path fragment on screen "${id}", which is not daemon-less`);
      } else add(half.plugin, `declares a fragment in no known form: ${JSON.stringify(decl)}`);
    }
    shellSectionFindings(half, add);
    if (half.skeleton && half.device.length > 0)
      add(
        half.plugin,
        `is a skeleton half with \`shell.device\` views (${half.device.join(', ')}): nothing mounts them`,
      );
  }
  for (const [key, plugins] of claims)
    if (plugins.length > 1)
      add(
        plugins[0] ?? '',
        `fragment key "${key}" is claimed ${plugins.length} times (${plugins.join(', ')}); a key has one owner, \`strip: false\` claims included`,
      );
  return found;
}

/** The slice of a loaded app half this check reads. */
interface LoadedHalf {
  readonly skeleton?: true;
  readonly shell?: {
    readonly fragments?: readonly unknown[];
    readonly device?: Readonly<Record<string, unknown>>;
    readonly background?: Readonly<Record<string, unknown>>;
    readonly deviceSettings?: Readonly<Record<string, unknown>>;
    readonly navPanels?: Readonly<Record<string, unknown>>;
    readonly navBadges?: Readonly<Record<string, unknown>>;
    readonly links?: unknown;
  };
}

export const check: Check = {
  name: 'shell-provides',
  summary: 'the fragments a plugin declares are its own, in the grammar, on its daemon-less screens, and taken',
  async run(ctx) {
    const halves: ShellProvidesHalf[] = [];
    const failures: Finding[] = [];
    for (const subsystem of (await ctx.model()).loaded) {
      try {
        const half = (await loadHalf(subsystem.pkg, 'app')) as LoadedHalf | undefined;
        if (half === undefined) continue;
        halves.push({
          plugin: subsystem.id,
          skeleton: half.skeleton === true,
          screens: (subsystem.manifest.ui?.screens ?? []) as ShellProvidesHalf['screens'],
          fragments: half.shell?.fragments ?? [],
          device: Object.keys(half.shell?.device ?? {}),
          panels: (subsystem.manifest.ui?.panels ?? []) as NonNullable<ShellProvidesHalf['panels']>,
          background: Object.keys(half.shell?.background ?? {}),
          deviceSettings: Object.keys(half.shell?.deviceSettings ?? {}),
          navPanels: Object.keys(half.shell?.navPanels ?? {}),
          navBadges: Object.keys(half.shell?.navBadges ?? {}),
          links: half.shell?.links !== undefined,
        });
      } catch (error) {
        failures.push({
          check: 'shell-provides',
          where: subsystem.id,
          message: `app half failed to load: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const found = [...failures, ...shellProvidesFindings(halves)];
    if (ctx.packageId === undefined) return found;
    const id = ctx.packageId;
    // Scoped to one package: what it declares, and a key it shares with another plugin.
    const named = new RegExp(`[(, ]${id.replace(/-/g, '\\-')}[,)]`);
    return found.filter(finding => finding.where === id || named.test(finding.message));
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
