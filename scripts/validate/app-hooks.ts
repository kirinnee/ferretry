/**
 * `app-hooks` (§5.2): an app hook is a value one plugin's half OFFERS a name for and another plugin's half PROVIDES
 * (`provideToShell`, `shell.hooks`). The shell gives a hook as `undefined` whenever the agreement is not exactly one
 * provider with the right shape, and the offerer then draws without it, so a broken agreement does not fail: it
 * quietly switches the feature off (Agenda's Done · closes, Start and Close, and the lane editor all ride on hooks).
 * This check makes it fail the build instead.
 *
 * The offerer declares its hooks in `contract/app-hooks.ts` as an exported `<ID>_APP_HOOKS` record of
 * `<offerer>.<name>` to the narrowing that says a value has the hook's shape. Then:
 *   - every offered hook is named `<offerer>.<name>`;
 *   - every offered hook has exactly one provider among the halves (none: the feature is silently off; two: the shell
 *     provides nothing, so it is off for both);
 *   - every hook a half provides under an offerer's prefix is one that offerer declares (a renamed hook);
 *   - the provider's factory builds, and what it builds passes the offerer's narrowing (a changed shape).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { loadHalf } from '../gen/lib/workspace.ts';

/** One plugin's declared offers: hook name to the narrowing of its value. */
export interface HookOffers {
  readonly plugin: string;
  readonly hooks: Readonly<Record<string, (value: unknown) => boolean>>;
}
/** One plugin's `shell.hooks`: hook name to the factory the shell calls per daemon. */
export interface HookProvides {
  readonly plugin: string;
  readonly hooks: Readonly<Record<string, (context: { readonly client: unknown; readonly daemon: string }) => unknown>>;
}

/** A client that answers nothing: a factory only builds against it, it never calls a daemon. */
const INERT_CLIENT = {
  call: async (): Promise<never> => {
    throw new Error('the app-hooks check has no daemon');
  },
  subscribe: (): (() => void) => () => undefined,
};

export function appHookFindings(offers: readonly HookOffers[], provides: readonly HookProvides[]): Finding[] {
  const found: Finding[] = [];
  const add = (where: string, message: string): number => found.push({ check: 'app-hooks', where, message });
  const offered = new Map<string, { readonly plugin: string; readonly narrows: (value: unknown) => boolean }>();
  for (const offer of offers)
    for (const [name, narrows] of Object.entries(offer.hooks)) {
      if (!name.startsWith(`${offer.plugin}.`))
        add(offer.plugin, `offers app hook "${name}", which is not named "${offer.plugin}.<name>"`);
      offered.set(name, { plugin: offer.plugin, narrows });
    }
  const providers = new Map<string, string[]>();
  for (const provide of provides)
    for (const name of Object.keys(provide.hooks))
      providers.set(name, [...(providers.get(name) ?? []), provide.plugin]);

  for (const [name, offer] of offered) {
    const taking = providers.get(name) ?? [];
    if (taking.length === 0)
      add(offer.plugin, `app hook "${name}" has no provider: no half gives \`shell.hooks["${name}"]\`, so it is off`);
    else if (taking.length > 1)
      add(
        offer.plugin,
        `app hook "${name}" has ${taking.length} providers (${taking.join(', ')}); the shell gives a hook with two providers to nobody`,
      );
  }
  const offerers = new Set(offers.map(offer => offer.plugin));
  for (const provide of provides)
    for (const [name, factory] of Object.entries(provide.hooks)) {
      const offer = offered.get(name);
      if (offer === undefined) {
        const prefix = name.split('.')[0] ?? '';
        add(
          provide.plugin,
          offerers.has(prefix)
            ? `provides app hook "${name}", which ${prefix} does not offer (renamed or misspelled?)`
            : `provides app hook "${name}", which no plugin offers`,
        );
        continue;
      }
      let value: unknown;
      try {
        value = factory({ client: INERT_CLIENT, daemon: 'check' });
      } catch (error) {
        add(
          provide.plugin,
          `app hook "${name}" failed to build: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!offer.narrows(value))
        add(provide.plugin, `app hook "${name}" builds a value without the shape ${offer.plugin} reads`);
    }
  return found;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const check: Check = {
  name: 'app-hooks',
  summary: 'every app hook a plugin offers has exactly one provider, under its own name, with the shape it reads',
  async run(ctx) {
    const offers: HookOffers[] = [];
    const provides: HookProvides[] = [];
    const failures: Finding[] = [];
    for (const subsystem of (await ctx.model()).loaded) {
      const file = join(subsystem.pkg.dir, 'contract', 'app-hooks.ts');
      if (existsSync(file)) {
        const module = (await import(file)) as Record<string, unknown>;
        const declared = Object.entries(module).filter(([key, value]) => /_APP_HOOKS$/.test(key) && isRecord(value));
        if (declared.length !== 1)
          failures.push({
            check: 'app-hooks',
            where: subsystem.id,
            message: `contract/app-hooks.ts must export exactly one <ID>_APP_HOOKS record (found ${declared.length})`,
          });
        else offers.push({ plugin: subsystem.id, hooks: declared[0]?.[1] as HookOffers['hooks'] });
      }
      try {
        const half = (await loadHalf(subsystem.pkg, 'app')) as
          | { readonly shell?: { readonly hooks?: HookProvides['hooks'] } }
          | undefined;
        const hooks = half?.shell?.hooks;
        if (hooks !== undefined) provides.push({ plugin: subsystem.id, hooks });
      } catch (error) {
        failures.push({
          check: 'app-hooks',
          where: subsystem.id,
          message: `app half failed to load: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const found = [...failures, ...appHookFindings(offers, provides)];
    if (ctx.packageId === undefined) return found;
    // Scoped to one package: what names it, as an offerer, a provider, or a hook of its prefix.
    const id = ctx.packageId;
    return found.filter(finding => finding.where === id || finding.message.includes(`"${id}.`));
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
