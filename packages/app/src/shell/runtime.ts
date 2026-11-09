import { type ClientOrigin, DaemonClient, type ShellPluginClient } from '../client/daemon-client.ts';
import type { Standing } from '../client/inventory.ts';
import {
  blockedLine,
  DEVICE_NOT_ACCEPTED_SENTENCE,
  remedyFor,
  type Remedy,
  wholeDaemonSentence,
} from '../client/sentences.ts';
import type { DaemonTransport } from '../client/transport.ts';
import { type DaemonList, daemonTitle, type PairedDaemon } from '../daemons/daemon-list.ts';
import type { RouteDecl } from '@ferretry/kernel/manifest';
import { DaemonReachCache } from './every-daemon.ts';
import { GrantsCache } from './grants-cache.ts';
import type { PluginReach } from './plugin-identity.tsx';
import type { Authority, Axis, CapabilityName, ViewPlace } from './view-place.tsx';
import { type BuiltHalf, HalfCache } from '../surfaces/halves.ts';
import { indexSurfaces, type SurfaceEntry } from '../surfaces/registry.ts';
import { DaemonLayouts } from '../layout/daemon-layout.ts';
import { noteClientDaemon } from '../connect/daemon-of.ts';
import type { PasskeyProvision } from '../passkey/passkey.ts';
import { AppHookCache, appHookProviders } from '../surfaces/app-hooks.ts';
import {
  type DaemonlessScreenProps,
  type DevicePanelSlot,
  type NavBadge,
  type RegisteredBackgroundView,
  type RegisteredDeviceView,
  type RegisteredDevicePanel,
  type RegisteredNavBadge,
  registeredBackgroundViews,
  registeredLinkProvider,
  registeredDevicePanels,
  registeredNavBadges,
  registeredDeviceViews,
  registeredForgets,
  registeredFragments,
  registeredNotificationOpened,
} from '../connect/provides.ts';
import { type AddressBrowser, AddressTaker, type HoldClock, REAL_CLOCK } from '../router/address.ts';
import { viewsOf } from '../layout/engine.ts';
import { HandOffs } from './hand-off.ts';
import type { NotificationOpenInbox } from '../worker/notification-open.ts';
import type { LinkProvision } from '../ui/external-link.tsx';
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
  /**
   * Calls its listener each time the app comes back to the foreground (`visibilitychange` to visible): a re-read
   * trigger for every machine's grants (S1). Absent, that trigger never fires.
   */
  readonly onVisible?: (listener: () => void) => () => void;
  /**
   * The address this tab shows (`window`), read for the plugins' declared fragments (S3) at construction — before the
   * first render and before any lazy chunk — and on every arrival. Absent, no fragment is ever read or held.
   */
  readonly address?: AddressBrowser;
  /** The clock held fragments and hand-offs expire on; a test hands a fake one. */
  readonly clock?: HoldClock;
  /** The notification-tap inbox the entry point made before React mounted (S6); absent, no tap is routed. */
  readonly notificationOpens?: NotificationOpenInbox;
}

const UNKNOWN: Authority = Object.freeze({ kind: 'unknown' });
const OPEN: Authority = Object.freeze({ kind: 'open' });
const NOT_GRANTED: Authority = Object.freeze({ kind: 'refused', refusal: 'not-granted' });

type Connection =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'unreachable' }
  /** A session ended with `4403` here: not dialled again by this page; the pairing and its key are untouched (S12). */
  | { readonly kind: 'refused' }
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
  /** THE one per-daemon grants cache (S1): every authority answer reads it. */
  readonly #grants = new GrantsCache(() => this.#changed());
  /** Every route a compiled manifest declares, by key: what `authorityOf` reads a capability from. */
  readonly #routes: ReadonlyMap<string, RouteDecl>;
  readonly #places = new Map<string, { readonly version: number; readonly place: ViewPlace }>();
  /** Each plugin's rows on every daemon (S2), per client origin, over the one client cache. */
  readonly #reach = new DaemonReachCache(this);
  #handlerWatched = false;
  /** The owner's layout per daemon (the Layouts plugin), read through each daemon's guarded client. */
  readonly layouts: DaemonLayouts;
  /** The plugins' declared fragments, held off the address until their one taker comes (S3). */
  readonly address: AddressTaker;
  /** Values carried in memory to a plugin's own screen (S3). */
  readonly handOffs: HandOffs;
  /** Every plugin's device views, mounted once each at the frame root (S3). */
  readonly deviceViews: readonly RegisteredDeviceView[];
  /** Taps the worker asked this page to open, held until the router is up and routed in the app (S6). */
  readonly notificationOpens: NotificationOpenInbox | undefined;
  /** Every plugin's background views, mounted once per paired daemon where the plugin may run (S5). */
  readonly backgroundViews: readonly RegisteredBackgroundView[];
  /** The device-level panels (`device.settings`, `nav`) the halves gave views for (S4). */
  readonly #devicePanels: Readonly<Record<DevicePanelSlot, ReadonlyMap<string, RegisteredDevicePanel>>>;
  readonly #navBadges: readonly RegisteredNavBadge[];
  readonly #links: ReturnType<typeof registeredLinkProvider>;
  readonly #addressBrowser: AddressBrowser | undefined;
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
    const screens = viewsOf(options.surfaces).screens;
    const screenOf = (plugin: string, screen: string) => screens.get(`${plugin}.${screen}`);
    this.#addressBrowser = options.address;
    this.notificationOpens = options.notificationOpens;
    this.address = new AddressTaker(registeredFragments(options.surfaces, screenOf), options.address, options.clock);
    this.handOffs = new HandOffs(screenOf, options.clock ?? REAL_CLOCK);
    this.deviceViews = registeredDeviceViews(options.surfaces);
    this.backgroundViews = registeredBackgroundViews(options.surfaces);
    this.#devicePanels = {
      'device.settings': registeredDevicePanels(options.surfaces, 'device.settings'),
      nav: registeredDevicePanels(options.surfaces, 'nav'),
    };
    this.#navBadges = registeredNavBadges(options.surfaces);
    this.#links = registeredLinkProvider(options.surfaces);
    this.#routes = new Map(
      options.surfaces.flatMap(entry => entry.manifest.actions?.routes ?? []).map(route => [route.key, route]),
    );
    options.onVisible?.(() => this.#grants.refreshAll());
    const forgets = registeredForgets(options.surfaces);
    // S12: once per unpair, after the device key and the paired record are gone; one plugin's failure costs only itself.
    this.daemons.onUnpaired(daemon => {
      for (const { forget } of forgets) {
        try {
          void Promise.resolve(forget(daemon)).catch(() => undefined);
        } catch {
          // a plugin whose forget throws still leaves the others to run
        }
      }
    });
    this.daemons.registerCache({ clearDaemon: daemon => this.#drop(daemon) });
    this.daemons.subscribe(() => this.#changed());
  }

  /**
   * The address moved inside this document (the router pushed or replaced an entry, or Back/Forward): the declared
   * fragments are read again, and a hand-off waiting for a screen not drawn there is dropped.
   */
  addressChanged = (): void => {
    this.address.read();
    const pathname = this.#addressBrowser?.location.pathname;
    if (pathname !== undefined) this.handOffs.navigated(pathname);
  };

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
    if (connection?.kind === 'refused') return DEVICE_NOT_ACCEPTED_SENTENCE;
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
    if (connection.kind === 'refused') return DEVICE_NOT_ACCEPTED_SENTENCE;
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
   * A notification of this machine was tapped and routed (S6): tells each plugin that asked (`notificationOpened`), over
   * its OWN guarded client, only where it is allowed. A plugin's failure costs only itself.
   *
   * FIRES ONLY FOR A MACHINE THAT IS ALREADY CONNECTED: a plugin whose client does not exist yet (the machine is still
   * connecting, is refused, or was unpaired) is skipped, not held, so a tap that cold-starts the app does not reach a
   * plugin whose machine has not connected by then (declared in `ports-pending.json`).
   */
  notificationOpened(daemon: string, tap: { readonly url: string; readonly tag?: string }): void {
    for (const { plugin, opened } of registeredNotificationOpened(this.surfaces)) {
      const client = this.client(daemon, plugin);
      if (client === undefined) continue;
      try {
        void Promise.resolve(opened({ client, daemon }, tap)).catch(() => undefined);
      } catch {
        // one plugin's failure never stops the next
      }
    }
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

  /**
   * One plugin's reader of its own rows on every paired daemon (S2), per client origin: the identity context hands it
   * out (`plugin-identity.tsx`), never a hook that takes a package id.
   */
  reach(plugin: string, origin: ClientOrigin): PluginReach {
    return this.#reach.reach(plugin, origin);
  }

  /** A plugin's device-level panel for `slot` (no daemon, no client), or `undefined` when it gave none (S4). */
  devicePanel(slot: DevicePanelSlot, plugin: string, id: string): RegisteredDevicePanel | undefined {
    return this.#devicePanels[slot].get(`${plugin}.${id}`);
  }

  /**
   * The nav-badge providers of one plugin's screen, one per paired daemon where the plugin is ALLOWED (S4, MA5): built
   * EAGERLY over that daemon's cache client — the half need not be built (R3 m8) — so a machine never opened still counts.
   * A blocked, paused or unread machine has no client and a skeleton half has no provider; a locked machine adds 0.
   *
   * The client is the BACKGROUND-origin entry (R1 m5): a badge is built at app open for every machine while none is on
   * screen and nobody pressed anything, so a provider that sends more than a read must never raise a passkey prompt for
   * a machine the person is not looking at. It waits for the unlock instead, as a background view does.
   */
  navBadges(plugin: string, screen: string): readonly NavBadge[] {
    const registered = this.#navBadges.find(each => each.plugin === plugin && each.screen === screen);
    if (registered === undefined) return [];
    const badges: NavBadge[] = [];
    for (const paired of this.daemons.snapshot().daemons) {
      if (this.#grants.isLocked(paired.daemon)) continue;
      const client = this.#halves.client(paired.daemon, plugin, 'background');
      if (client === undefined) continue;
      const built = this.#hooks.get(paired.daemon, plugin, `nav-badge:${screen}`, client, registered.provide);
      if (typeof (built as Partial<NavBadge> | undefined)?.count === 'function') badges.push(built as NavBadge);
    }
    return badges;
  }

  /**
   * What Browsers provides for one machine (`shell.links`, S7), built over Browsers' own client there once it is allowed
   * on that machine: where a link opens, and the sheet. `undefined` when no one provides it, Browsers is not allowed
   * there, or the provider threw — a link then opens as the native default.
   */
  linkProvision(daemon: string): LinkProvision | undefined {
    const provider = this.#links;
    if (provider === undefined) return undefined;
    const client = this.#halves.client(daemon, provider.plugin);
    if (client === undefined) return undefined;
    const built = this.#hooks.get(daemon, provider.plugin, 'links', client, provider.provide) as
      | Partial<LinkProvision>
      | undefined;
    return typeof built?.activate === 'function' &&
      typeof built.open === 'function' &&
      typeof built.destination === 'function'
      ? (built as LinkProvision)
      : undefined;
  }

  /** The plugin that provides link behaviour (S7), or `undefined` when none does. */
  linkProvider(): string | undefined {
    return this.#links?.plugin;
  }

  /** Whether this machine's grants read answered "unlock first" (S1's `locked`). */
  isLocked(daemon: string): boolean {
    return this.#grants.isLocked(daemon);
  }

  /** What a reach row of this daemon was read from besides its own fields: its inventory and its grants answer. */
  stampOf(daemon: string): readonly unknown[] {
    const connection = this.#connections.get(daemon);
    return [connection?.kind === 'connected' ? connection.client.inventory : undefined, this.#grants.stateOf(daemon)];
  }

  /** Whether the daemon's event feed is live (a view's `online`). */
  online(daemon: string): boolean {
    const connection = this.#connections.get(daemon);
    return connection?.kind === 'connected' && connection.client.feedLive;
  }

  /** What this device may do with (capability, axis) on this daemon, from the one grants cache. */
  authority(daemon: string, capability: CapabilityName, axis: Axis): Authority {
    return this.#grants.authority(daemon, capability, axis);
  }

  /**
   * The authority of a route a compiled manifest declares: `not-granted` from the descriptor alone for an
   * `admin-token` route (a paired device's class is never one); the machine's unlock or first read for a route no
   * capability governs; the grants row for a governed one. An undeclared route is `unknown`, never `open`.
   */
  authorityOf(daemon: string, route: string): Authority {
    const declared = this.#routes.get(route);
    if (declared === undefined) return UNKNOWN;
    if (declared.minimum === 'admin-token') return NOT_GRANTED;
    const demand = declared.capability;
    if (demand !== undefined) return this.#grants.authority(daemon, demand.capability, demand.axis);
    const machine = this.#grants.authority(daemon, 'fleet', 'use');
    return machine.kind === 'unknown' || machine.kind === 'locked' ? machine : OPEN;
  }

  /** THE one locked set (R3 m5): every machine whose grants read answered "unlock first". */
  lockedDaemons(): readonly string[] {
    return this.#grants.locked();
  }

  /**
   * The person's explicit unlock of one machine (a press, never on mount): the handler's own `confirm` with origin
   * `explicit`, which asks at once and settles that machine's waiting reads. It does NOT move the passkey's focus —
   * only `PasskeyMount` does (MA6). A `true` re-reads that machine's grants.
   */
  async unlock(daemon: string): Promise<boolean> {
    const handler = this.#passkey()?.handler;
    const paired = this.daemons.get(daemon);
    if (handler === undefined || paired === undefined) return false;
    let confirmed: boolean;
    try {
      confirmed = (await handler.confirm(paired, { kind: 'unlock' }, 'explicit')) === true;
    } catch {
      confirmed = false;
    }
    if (confirmed) this.noteConfirmed(daemon);
    return confirmed;
  }

  /** A press on one machine: on a `locked` machine the unlock comes first, and a dismissed one runs nothing. */
  async press<T>(daemon: string, act: () => Promise<T>): Promise<T | undefined> {
    if (this.#grants.isLocked(daemon) && !(await this.unlock(daemon))) return undefined;
    return await act();
  }

  /** A confirm the shell forwarded for this machine outside a client's pause (`usePasskeyAsk`): re-read its grants. */
  noteConfirmed(daemon: string): void {
    const connection = this.#connections.get(daemon);
    if (connection?.kind === 'connected') connection.client.noteConfirmed();
  }

  /** Where a per-daemon view of this daemon is drawn: the same object until the runtime next changes. */
  place(daemon: string): ViewPlace {
    const version = this.#version;
    const known = this.#places.get(daemon);
    if (known !== undefined && known.version === version) return known.place;
    const paired = this.daemons.get(daemon);
    const place: ViewPlace = {
      daemon,
      machine: paired === undefined ? daemon : daemonTitle(paired),
      online: this.online(daemon),
      authority: (capability, axis) => this.authority(daemon, capability, axis),
      authorityOf: route => this.authorityOf(daemon, route),
      press: act => this.press(daemon, act),
    };
    this.#places.set(daemon, { version, place });
    return place;
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
    // It is also a re-read trigger for the machine's grants, the first read included.
    this.#grants.attach(paired.daemon, client);
    client.onChange(() => {
      this.#halves.clearDaemon(paired.daemon);
      this.#hooks.clearDaemon(paired.daemon);
      this.#grants.refresh(paired.daemon);
      this.#changed();
    });
    // A session ended with `4403` (S12). That close is cleartext a relay can forge, so it is NOT an unpair: nothing is
    // removed, no key is deleted and no plugin forgets anything. This page just stops dialling the machine and says
    // so ("Pair again"); a reload asks the daemon again. Another machine is never touched.
    client.onRefused(() => {
      const held = this.#connections.get(paired.daemon);
      if (held?.kind === 'connected' && held.client === client) this.#refuse(paired.daemon, held);
    });
    // The feed coming back is a re-read trigger; every change of it re-renders the views' `online`.
    client.onFeedLive(live => {
      if (live) this.#grants.refresh(paired.daemon);
      this.#changed();
    });
    // Best effort: the handler's own change (a prompt settled) re-reads the machines that wait on their unlock.
    if (handler !== undefined && !this.#handlerWatched) {
      this.#handlerWatched = true;
      handler.subscribe(() => this.#grants.refreshLocked());
    }
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

  /** Stops dialling a machine this page was refused on (`4403`), keeping its pairing; see {@link DaemonClient.onRefused}. */
  #refuse(daemon: string, held: Extract<Connection, { kind: 'connected' }>): void {
    held.client.stop();
    held.transport.close?.();
    this.#connections.set(daemon, { kind: 'refused' });
    this.#grants.drop(daemon);
    this.#places.delete(daemon);
    this.#halves.dropDaemon(daemon);
    this.#hooks.clearDaemon(daemon);
    this.#changed();
  }

  /** Whether this page was refused on this machine (`4403`): the frame says so and offers to pair again. */
  isRefused(daemon: string): boolean {
    return this.#connections.get(daemon)?.kind === 'refused';
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
    this.#grants.drop(daemon);
    this.#places.delete(daemon);
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
