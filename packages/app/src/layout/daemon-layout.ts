import { CurrentLayoutSchema, LayoutsChanged } from '@ferretry/plugin-layouts/contract';
import type { ShellPluginClient } from '../client/daemon-client.ts';
import type { Layout } from './layout.ts';

/**
 * THE OWNER'S LAYOUT, FROM THE DAEMON (§5.3): the Layouts plugin answers `GET /v1/layouts/current` with
 * `config/layout.yaml`'s layout and overrides applied, and publishes `layouts.changed` after every write, so a
 * `fy layout set` "takes effect at once on every open app, through a wake-up".
 *
 * Read through the generated per-daemon client as the `layouts` package, so the hash guard applies like to any other
 * call: with Layouts off, skeleton, or on another contract hash, nothing is sent and the shell keeps the built-in
 * default (§5.3: "with Layouts off, the shell uses that default"). A read that fails or does not parse is the same as
 * no layout; the shell's own check (`chooseLayout`) still refuses one that names a view this app lacks.
 */

/** The Layouts plugin's id: the package whose client the read goes through. */
export const LAYOUTS_PLUGIN = 'layouts';
const CURRENT_ROUTE = 'GET /v1/layouts/current';

/** What the channel needs from the shell runtime: the guarded client of one package on one daemon, when allowed. */
export interface PackageClients {
  packageClient(daemon: string, packageId: string): ShellPluginClient | undefined;
}

interface Watch {
  readonly client: ShellPluginClient;
  readonly cancel: () => void;
  layout: Layout | undefined;
  /** Bumped per read, so an older answer that lands late cannot replace a newer one. */
  generation: number;
}

export class DaemonLayouts {
  readonly #clients: PackageClients;
  readonly #watches = new Map<string, Watch>();
  readonly #listeners = new Set<() => void>();

  constructor(clients: PackageClients) {
    this.#clients = clients;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The owner's layout on this daemon, as last read; `undefined` until read, or when Layouts may not run there. */
  current(daemon: string): Layout | undefined {
    return this.#watches.get(daemon)?.layout;
  }

  /**
   * Starts (or keeps) watching a daemon's layout. Call again whenever the runtime changes: a package that became
   * allowed starts its read, one that became blocked stops and its layout is dropped, a replaced client is re-read.
   */
  watch(daemon: string): void {
    const client = this.#clients.packageClient(daemon, LAYOUTS_PLUGIN);
    const known = this.#watches.get(daemon);
    if (known !== undefined && known.client === client) return;
    if (known !== undefined) {
      known.cancel();
      this.#watches.delete(daemon);
      if (known.layout !== undefined) this.#changed();
    }
    if (client === undefined) return;
    const watch: Watch = {
      client,
      layout: undefined,
      generation: 0,
      cancel: client.subscribe(LayoutsChanged, () => void this.#read(daemon, watch)),
    };
    this.#watches.set(daemon, watch);
    void this.#read(daemon, watch);
  }

  /** Stops every watch (the daemon was unpaired, or the app is closing). */
  stop(daemon: string): void {
    const known = this.#watches.get(daemon);
    if (known === undefined) return;
    known.cancel();
    this.#watches.delete(daemon);
    this.#changed();
  }

  async #read(daemon: string, watch: Watch): Promise<void> {
    watch.generation += 1;
    const generation = watch.generation;
    let layout: Layout | undefined;
    try {
      const parsed = CurrentLayoutSchema.safeParse(await watch.client.call(CURRENT_ROUTE));
      layout = parsed.success ? parsed.data.layout : undefined;
    } catch {
      layout = undefined;
    }
    if (this.#watches.get(daemon) !== watch || watch.generation !== generation) return;
    watch.layout = layout;
    this.#changed();
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
