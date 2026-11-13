import type {
  AppHalf,
  Manifest,
  PanelProps,
  RendererProps,
  ScreenProps,
  SettingsProps,
} from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import type { ClientOrigin, ShellPluginClient } from '../client/daemon-client.ts';
import type { Standing } from '../client/inventory.ts';
import type { SurfaceEntry } from './registry.ts';

/**
 * BUILDING THE APP HALVES (§3.3, §5.1). A half's `build` receives the client it talks through, and a client is
 * per daemon (§9.6), so a half is built once per (daemon, package), lazily, the first time one of its views is
 * drawn for that daemon — after the bootstrap read, so no plugin code starts before it (§9.6).
 *
 * The leaf keeps `AppComponent` framework-neutral (lead decision, spine.md §11); the shell narrows it to React here,
 * at the one place halves enter the app.
 */

/** A plugin view, narrowed to React. */
export type View<Props> = (props: Props) => ReactNode;

export type BuiltHalf =
  | { readonly kind: 'skeleton' }
  /** `build` threw: the plugin's views show one line; every other plugin keeps working. */
  | { readonly kind: 'failed'; readonly reason: string }
  | {
      readonly kind: 'built';
      readonly screens: Readonly<Record<string, View<ScreenProps>>>;
      readonly panels: Readonly<Record<string, View<PanelProps>>>;
      readonly settings: Readonly<Record<string, View<SettingsProps>>>;
      readonly renderers: Readonly<Record<string, View<RendererProps>>>;
    };

const NONE: BuiltHalf = Object.freeze({ kind: 'skeleton' });

function buildHalf(entry: SurfaceEntry, client: ShellPluginClient): BuiltHalf {
  const half = entry.app;
  if (half === undefined || half.skeleton === true || half.build === undefined) return NONE;
  let built: AppHalf<Manifest>;
  try {
    built = half.build({ manifest: entry.manifest, client }) as AppHalf<Manifest>;
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
  const narrow = <P>(section: unknown): Readonly<Record<string, View<P>>> =>
    (section ?? {}) as Readonly<Record<string, View<P>>>;
  return {
    kind: 'built',
    screens: narrow<ScreenProps>(built.screens),
    panels: narrow<PanelProps>(built.panels),
    settings: narrow<SettingsProps>(built.settings),
    renderers: narrow<RendererProps>(built.renderers),
  };
}

/**
 * THE ONE CLIENT CACHE (shell contract S2), and the halves built over it. Clients are keyed by (daemon, package,
 * origin): `ordinary` is the client a half is built with and its views and app hooks call through, so what a hook
 * reads and what the half's views read is one store; `background` is the same package's client whose every call is a
 * background read for the passkey (`DaemonClient.forPackage(…, { origin })`), the one a background view is handed.
 *
 * A CLIENT LIVES AS LONG AS ITS CONNECTION (R3 MJ2): a transport reconnect or a `kernel.plugins-changed` rebuilds the
 * halves ({@link clearDaemon}) but keeps every client, so a watcher holding one (Layouts) never sees it change; only an
 * unpair drops them ({@link dropDaemon}). THE STANDING CHECK IS AT READ TIME: a blocked or paused package is answered
 * `undefined`, and once it is allowed again the SAME cached object comes back.
 */
export class HalfCache {
  readonly #byDaemon = new Map<string, Map<string, BuiltHalf>>();
  readonly #clients = new Map<string, Map<string, ShellPluginClient>>();

  constructor(
    private readonly surfaces: ReadonlyMap<string, SurfaceEntry>,
    private readonly clientFor: (
      daemon: string,
      packageId: string,
      origin: ClientOrigin,
    ) => ShellPluginClient | undefined,
    private readonly standing: (daemon: string, packageId: string) => Standing,
  ) {}

  /**
   * The client a package talks through on this daemon, for this origin: the one its half is (or will be) built with
   * when `ordinary`. `undefined` before the daemon answers, and while the package is not allowed there.
   */
  client(daemon: string, packageId: string, origin: ClientOrigin = 'ordinary'): ShellPluginClient | undefined {
    if (this.standing(daemon, packageId).state !== 'allowed') return undefined;
    let clients = this.#clients.get(daemon);
    if (clients === undefined) {
      clients = new Map();
      this.#clients.set(daemon, clients);
    }
    const key = `${packageId}\u0000${origin}`;
    const known = clients.get(key);
    if (known !== undefined) return known;
    const client = this.clientFor(daemon, packageId, origin);
    if (client !== undefined) clients.set(key, client);
    return client;
  }

  get(daemon: string, packageId: string): BuiltHalf | undefined {
    const entry = this.surfaces.get(packageId);
    if (entry === undefined) return undefined;
    let halves = this.#byDaemon.get(daemon);
    if (halves === undefined) {
      halves = new Map();
      this.#byDaemon.set(daemon, halves);
    }
    const cached = halves.get(packageId);
    if (cached !== undefined) return cached;
    const client = this.client(daemon, packageId);
    if (client === undefined) return undefined;
    const built = buildHalf(entry, client);
    halves.set(packageId, built);
    return built;
  }

  /** The daemon's halves are rebuilt on their next draw (its inventory changed); its clients stay. */
  clearDaemon(daemon: string): void {
    this.#byDaemon.delete(daemon);
  }

  /** The daemon was unpaired: its halves AND its clients go. A re-pair is a new connection and new clients. */
  dropDaemon(daemon: string): void {
    this.#byDaemon.delete(daemon);
    this.#clients.delete(daemon);
  }
}

/**
 * Renderer keys (§5.2): `ask:<source>` and `reference:<prefix>`, each a provide hook of the app. One provider per
 * key; a second plugin offering the same key is a manifest conflict the generator refuses, so the first wins here.
 */
/** @public The renderer-key owner table the reference and ask renderers look a key up in (§5.2); not drawn by the frame yet. */
export function rendererOwners(surfaces: readonly SurfaceEntry[]): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const entry of surfaces) {
    for (const renderer of entry.manifest.ui?.renderers ?? []) {
      if (!owners.has(renderer.key)) owners.set(renderer.key, entry.id);
    }
  }
  return owners;
}
