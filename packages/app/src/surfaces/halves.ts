import type {
  AppHalf,
  Manifest,
  PanelProps,
  RendererProps,
  ScreenProps,
  SettingsProps,
} from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import type { ShellPluginClient } from '../client/daemon-client.ts';
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

export function buildHalf(entry: SurfaceEntry, client: ShellPluginClient): BuiltHalf {
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

/** Memoised halves per daemon. Cleared for a daemon when it is unpaired or its client is replaced. */
export class HalfCache {
  readonly #byDaemon = new Map<string, Map<string, BuiltHalf>>();

  constructor(
    private readonly surfaces: ReadonlyMap<string, SurfaceEntry>,
    private readonly clientFor: (daemon: string, packageId: string) => ShellPluginClient | undefined,
  ) {}

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
    const client = this.clientFor(daemon, packageId);
    if (client === undefined) return undefined;
    const built = buildHalf(entry, client);
    halves.set(packageId, built);
    return built;
  }

  clearDaemon(daemon: string): void {
    this.#byDaemon.delete(daemon);
  }
}

/**
 * Renderer keys (§5.2): `ask:<source>` and `reference:<prefix>`, each a provide hook of the app. One provider per
 * key; a second plugin offering the same key is a manifest conflict the generator refuses, so the first wins here.
 */
export function rendererOwners(surfaces: readonly SurfaceEntry[]): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const entry of surfaces) {
    for (const renderer of entry.manifest.ui?.renderers ?? []) {
      if (!owners.has(renderer.key)) owners.set(renderer.key, entry.id);
    }
  }
  return owners;
}
