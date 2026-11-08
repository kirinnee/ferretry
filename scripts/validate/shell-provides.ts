/**
 * `shell-provides` (shell contract §2): what an app half hands the shell through `provideToShell` that the shell would
 * otherwise drop or mishandle in silence. This file holds the S3 rules — the declared address fragments and the device
 * views that take them; each later shell item adds its own rules here.
 *
 *   - a keyed fragment key claimed by two plugins (or twice by one) fails, `strip: false` claims included: the shell
 *     would hand one link to two takers, or strip a key another plugin keeps in the address;
 *   - a keyed key outside the grammar (`FRAGMENT_KEY`) fails;
 *   - a path declaration on a screen the plugin does not declare, or on one that is not daemon-less, fails;
 *   - a stripping keyed declaration with no `device` view fails: the shell would strip a link nothing can take;
 *   - a `device` view on a skeleton half fails: a half that implements nothing has no view to mount;
 *   - a declaration in no known form fails.
 */
import { FRAGMENT_KEY } from '../../packages/app/src/router/address.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { loadHalf } from '../gen/lib/workspace.ts';

/** One plugin's app half, as this check reads it. */
export interface ShellProvidesHalf {
  readonly plugin: string;
  readonly skeleton: boolean;
  /** The screens the plugin's manifest declares. */
  readonly screens: readonly { readonly id: string; readonly daemonless?: boolean }[];
  /** `shell.fragments`, as written (unchecked). */
  readonly fragments: readonly unknown[];
  /** The names of `shell.device`'s views. */
  readonly device: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

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
  readonly shell?: { readonly fragments?: readonly unknown[]; readonly device?: Readonly<Record<string, unknown>> };
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
