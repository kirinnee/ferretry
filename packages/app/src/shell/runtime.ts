import { type ClientOrigin, DaemonClient, type ShellPluginClient } from '../client/daemon-client.ts';
import type { Standing } from '../client/inventory.ts';
import { blockedLine, remedyFor, type Remedy, wholeDaemonSentence } from '../client/sentences.ts';
import type { DaemonTransport } from '../client/transport.ts';
import type { DaemonList, PairedDaemon } from '../daemons/daemon-list.ts';
import { type BuiltHalf, HalfCache } from '../surfaces/halves.ts';
import { indexSurfaces, type SurfaceEntry } from '../surfaces/registry.ts';
import { DaemonLayouts } from '../layout/daemon-layout.ts';
import { noteClientDaemon } from '../connect/daemon-of.ts';
import type { PasskeyProvision } from '../passkey/passkey.ts';
import { AppHookCache, appHookProviders } from '../surfaces/app-hooks.ts';
import type { DaemonlessScreenProps } from '../connect/provides.ts';
import type { View } from '../surfaces/halves.ts';

/**
 * THE SHELL'S RUNTIME: one generated client per paired daemon, started on first use; the halves built against it;
 * and one change signal the React tree reads through `useSyncExternalStore`. No feature lives here.
 */

/**
 * How the shell reaches one daemon (§4.8, §4.13): the device's session claim (Access's non-extractable key) and the
 * carrier (Connections' choice) put together into a transport. Answers `undefined` when this device cannot open a
 * session to that daemon yet; the shell then says so and sends nothing.
 */
export type TransportFactory = (daemon: PairedDaemon) => Promise<DaemonTransport | undefined>;

export interface ShellRuntimeOptions {
  readonly appVersion: string;
  readonly surfaces: readonly SurfaceEntry[];
  readonly daemons: DaemonList;
  readonly connect: TransportFactory;
  /**
   * Access's passkey provision, read per connection (`passkey/passkey.ts`): its handler is what every daemon call
   * consults on an unlock or step-up refusal, its prompts what the frame mounts. Absent, nothing asks.
   */
  readonly passkey?: () => PasskeyProvision | undefined;
  /**
   * The plugins' daemon-less screens (`<plugin>.<screen>` → view) and the address this tab was opened at, read on
   * demand (`connect/provides.ts`). Absent, a daemon-less route draws the skeleton line.
   */
  readonly daemonless?: {
    readonly views: ReadonlyMap<string, View<DaemonlessScreenProps>>;
    readonly location: () => string;
  };
}

type Connection =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'connected'; readonly client: DaemonClient; readonly transport: DaemonTransport };

export class ShellRuntime {
  readonly appVersion: string;
  readonly surfaces: readonly SurfaceEntry[];
  readonly byId: ReadonlyMap<string, SurfaceEntry>;
  readonly daemons: DaemonList;
  readonly #connect: TransportFactory;
  readonly #passkey: () => PasskeyProvision | undefined;
  readonly #daemonless: NonNullable<ShellRuntimeOptions['daemonless']>;
  readonly #connections = new Map<string, Connection>();
  readonly #halves: HalfCache;
  readonly #hooks = new AppHookCache();
  /** The owner's layout per daemon (the Layouts plugin), read through each daemon's guarded client. */
  readonly layouts: DaemonLayouts;
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(options: ShellRuntimeOptions) {
    this.appVersion = options.appVersion;
    this.surfaces = options.surfaces;
    this.byId = indexSurfaces(options.surfaces);
    this.daemons = options.daemons;
    this.#connect = options.connect;
    this.#passkey = options.passkey ?? (() => undefined);
    this.#daemonless = options.daemonless ?? { views: new Map(), location: () => '' };
    this.#halves = new HalfCache(
      this.byId,
      (daemon, id, origin) => this.#clientFor(daemon, id, origin),
      (daemon, id) => this.standing(daemon, id),
    );
    this.layouts = new DaemonLayouts(this);
    this.daemons.registerCache({ clearDaemon: daemon => this.#drop(daemon) });
    this.daemons.subscribe(() => this.#changed());
  }

  /** A number that changes on every runtime change: the React snapshot. */
  version = (): number => this.#version;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  titleOf = (id: string): string => this.byId.get(id)?.title ?? id;

  /** The one passkey provision (the handler and its prompts), or `undefined` when Access gave none. */
  passkey(): PasskeyProvision | undefined {
    return this.#passkey();
  }

  /** A plugin's daemon-less screen, or `undefined` when it gave none. Nothing about a daemon is read to find it. */
  daemonlessView(plugin: string, screen: string): View<DaemonlessScreenProps> | undefined {
    return this.#daemonless.views.get(`${plugin}.${screen}`);
  }

  /** The address this tab was opened at, fragment included: for a daemon-less screen to take what it needs once. */
  location = (): string => this.#daemonless.location();

  /** The connection to a daemon, opening it on first ask. */
  connection(daemon: string): Connection {
    const known = this.#connections.get(daemon);
    if (known !== undefined) return known;
    const paired = this.daemons.get(daemon);
    if (paired === undefined) return { kind: 'unreachable' };
    const connecting: Connection = { kind: 'connecting' };
    this.#connections.set(daemon, connecting);
    void this.#open(paired, connecting);
    return connecting;
  }

  standing(daemon: string, packageId: string): Standing {
    const connection = this.connection(daemon);
    if (connection.kind !== 'connected') return { state: 'blocked', reason: 'unread' };
    return connection.client.standing(packageId);
  }

  remedy(daemon: string): Remedy {
    const connection = this.#connections.get(daemon);
    return remedyFor(this.appVersion, connection?.kind === 'connected' ? connection.client.daemonVersion : undefined);
  }

  /** The full-screen sentence when nothing may run on this daemon, else `undefined`. */
  wholeDaemonLine(daemon: string): string | undefined {
    const connection = this.#connections.get(daemon);
    if (connection?.kind !== 'connected') return undefined;
    const inventory = connection.client.inventory;
    if (inventory === undefined) return undefined;
    const kernel = connection.client.standing('kernel');
    if (inventory.kind === 'read' && !(kernel.state === 'blocked' && kernel.reason === 'core')) return undefined;
    return wholeDaemonSentence(this.remedy(daemon));
  }

  /** The one line a blocked package shows on this daemon, or `undefined` when it may run. */
  blockedLine(daemon: string, packageId: string): string | undefined {
    const connection = this.connection(daemon);
    if (connection.kind === 'unreachable') return 'This device cannot reach this daemon yet.';
    return blockedLine(this.titleOf(packageId), this.standing(daemon, packageId), this.remedy(daemon), this.titleOf);
  }

  /** A package's built half on this daemon, only once it is allowed there (no plugin code starts before). */
  half(daemon: string, packageId: string): BuiltHalf | undefined {
    if (this.standing(daemon, packageId).state !== 'allowed') return undefined;
    return this.#halves.get(daemon, packageId);
  }

  /**
   * The value the ONE provider of app hook `name` gives on this daemon (`shell/app-hooks.ts`), built over the client
   * that provider's half is built with, only once that provider is allowed there; `undefined` otherwise, and when no
   * half or more than one provides it.
   */
  appHook(daemon: string, name: string): unknown {
    const providers = appHookProviders(this.surfaces, name);
    const only = providers.length === 1 ? providers[0] : undefined;
    if (only === undefined) return undefined;
    const client = this.#halves.client(daemon, only.plugin);
    if (client === undefined) return undefined;
    return this.#hooks.get(daemon, only.plugin, name, client, only.provide);
  }

  /**
   * The guarded client one package talks through on a daemon, from THE ONE CLIENT CACHE (`HalfCache`), only while it
   * is allowed there: the client its half is built with, the same object for as long as that connection lives (a
   * reconnect keeps it), so a watcher can tell a replaced client from the one it holds. Shell-internal: no hook hands a
   * package id in; plugins reach their own client through their views and `reach` (S2).
   */
  client(daemon: string, packageId: string, origin: ClientOrigin = 'ordinary'): ShellPluginClient | undefined {
    return this.#halves.client(daemon, packageId, origin);
  }

  async #open(paired: PairedDaemon, connecting: Connection): Promise<void> {
    let transport: DaemonTransport | undefined;
    try {
      transport = await this.#connect(paired);
    } catch {
      transport = undefined;
    }
    // A connection that finishes opening into an entry nobody holds any more (the daemon was unpaired, or unpaired and
    // paired again, while it dialled) is closed, not installed (R568): nothing would ever drop it again.
    if (this.#connections.get(paired.daemon) !== connecting) {
      transport?.close?.();
      return;
    }
    if (transport === undefined) {
      this.#connections.set(paired.daemon, { kind: 'unreachable' });
      this.#changed();
      return;
    }
    const handler = this.#passkey()?.handler;
    const client = new DaemonClient({
      transport,
      surfaces: this.surfaces,
      ...(handler === undefined ? {} : { passkey: { daemon: paired, handler } }),
    });
    // An inventory change (start, a reconnect, `kernel.plugins-changed`) rebuilds the halves and hooks; the clients stay.
    client.onChange(() => {
      this.#halves.clearDaemon(paired.daemon);
      this.#hooks.clearDaemon(paired.daemon);
      this.#changed();
    });
    this.#connections.set(paired.daemon, { kind: 'connected', client, transport });
    this.#changed();
    await client.start();
  }

  #clientFor(daemon: string, packageId: string, origin: ClientOrigin): ShellPluginClient | undefined {
    const connection = this.#connections.get(daemon);
    if (connection?.kind !== 'connected') return undefined;
    const client = connection.client.forPackage(packageId, { origin });
    noteClientDaemon(client, daemon);
    return client;
  }

  #drop(daemon: string): void {
    const connection = this.#connections.get(daemon);
    if (connection?.kind === 'connected') {
      connection.client.stop();
      // The transport's own sessions end here too (R568): the client only stops what it holds, and a request lane
      // opened by this device would otherwise stay live after the unpair.
      connection.transport.close?.();
    }
    this.#connections.delete(daemon);
    // The only place a daemon's clients go: a re-pair opens a new connection, so its clients are new objects.
    this.#halves.dropDaemon(daemon);
    this.#hooks.clearDaemon(daemon);
    this.layouts.stop(daemon);
  }

  #changed(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}
