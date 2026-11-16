import type { PluginClient } from '@ferretry/kernel/manifest';
import type { SurfaceEntry } from './registry.ts';

/**
 * APP PROVIDE HOOKS (§5.2): a value one plugin's half OFFERS a name for and another plugin's half PROVIDES.
 *
 * A slot carries a panel the offerer mounts; a hook carries a value the offerer READS — a verb, a resolver, a link —
 * where what the offerer draws must stay its own (Agenda's Done · closes button sits in Agenda's own answer row, but
 * the card it closes is Board's). The offerer names the hook `<offerer>.<name>` in its contract, with the value's shape
 * and a narrowing; the provider gives a factory under its app half's `shell.hooks` (`provideToShell`). Neither half
 * imports the other: the name and the shape are the whole agreement, as for a slot.
 *
 * - BUILT OVER THE PROVIDER'S OWN CLIENT, per daemon: the same guarded client its views are built with (`HalfCache`),
 *   so a hook reads the provider's one store, and every call it makes is the provider's own, by route key, under that
 *   daemon's authority. The shell adds no authority of its own; the daemon's route stays the authority.
 * - ONLY ONCE THE PROVIDER MAY RUN THERE: a provider that is not allowed on that daemon (paused, blocked, unread)
 *   provides nothing, exactly as its views draw nothing.
 * - EXACTLY ONE PROVIDER. Two halves providing one name provide nothing: an offerer never guesses whose value to act
 *   on. A factory that throws provides nothing. In each case the offerer draws as it does without the provider.
 * - Outside a shell (a harness, a test) there is no hook.
 */

/** What a provider's factory is given: its own client on one daemon, and that daemon. */
export interface AppHookContext {
  readonly client: PluginClient;
  readonly daemon: string;
}

/** One provider's factory for one hook name, built once per daemon (until that daemon's client is replaced). */
export type AppHookProvider = (context: AppHookContext) => unknown;

/** What a half's `shell.hooks` holds: hook names (`<offerer>.<name>`) to factories. */
export type AppHookProviders = Readonly<Record<string, AppHookProvider>>;

interface HookProvidingHalf {
  readonly skeleton?: boolean;
  readonly shell?: { readonly hooks?: AppHookProviders };
}

/** The halves in the registry that provide `name`, with their plugin id. */
export function appHookProviders(
  surfaces: readonly SurfaceEntry[],
  name: string,
): readonly { readonly plugin: string; readonly provide: AppHookProvider }[] {
  return surfaces.flatMap(entry => {
    const half = entry.app as HookProvidingHalf | undefined;
    if (half === undefined || half.skeleton === true) return [];
    const provide = half.shell?.hooks?.[name];
    return typeof provide === 'function' ? [{ plugin: entry.id, provide }] : [];
  });
}

/** A built hook, or the fact that building it failed (so it is not tried again until the daemon's client changes). */
type Built = { readonly value: unknown } | { readonly failed: true };

/** Memoised hook values per daemon, keyed `<plugin>\u0000<name>`. Cleared with the daemon's halves. */
export class AppHookCache {
  readonly #byDaemon = new Map<string, Map<string, Built>>();

  /** The value `provide` gives on `daemon` over `client`, built on first ask; `undefined` when it threw. */
  get(daemon: string, plugin: string, name: string, client: PluginClient, provide: AppHookProvider): unknown {
    let built = this.#byDaemon.get(daemon);
    if (built === undefined) {
      built = new Map();
      this.#byDaemon.set(daemon, built);
    }
    const key = `${plugin}\u0000${name}`;
    let known = built.get(key);
    if (known === undefined) {
      try {
        known = { value: provide({ client, daemon }) };
      } catch {
        known = { failed: true };
      }
      built.set(key, known);
    }
    return 'value' in known ? known.value : undefined;
  }

  clearDaemon(daemon: string): void {
    this.#byDaemon.delete(daemon);
  }
}
