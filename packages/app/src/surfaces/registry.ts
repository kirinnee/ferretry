import type { AppImplementation, Manifest } from '@ferretry/kernel/manifest';

/**
 * ONE ENTRY OF `src/generated/surfaces.ts` — the shape the generator (`scripts/gen/registries.ts`, §7.5) writes and
 * the shell consumes. One entry per package (the five core pieces and every plugin), in start order.
 *
 * `contract` is the package's EFFECTIVE contract hash as compiled into this app (§9.6): its own published surface
 * folded with the effective hash of every contract its client halves consume. `consumes` names those packages, so the
 * shell can say "needs Board, which needs an update" instead of only "update this daemon".
 */
export interface SurfaceEntry {
  readonly id: string;
  readonly title: string;
  readonly core: boolean;
  readonly contract: string;
  readonly consumes: readonly string[];
  readonly manifest: Manifest;
  /**
   * The package's app half; absent for a package with none (the kernel). Each half is typed by its own literal
   * manifest, and `build` is contravariant in it, so the list can only hold them widened.
   */
  // biome-ignore lint/suspicious/noExplicitAny: a heterogeneous registry of halves typed by their own manifests.
  readonly app?: AppImplementation<any>;
}

/** What the generated module exports. */
export interface GeneratedSurfaces {
  /** The release version this app was built from (`release.json`). */
  readonly appVersion: string;
  readonly surfaces: readonly SurfaceEntry[];
}

/** Indexes the registry by id; a duplicate id is a generator bug and fails loudly at start. */
export function indexSurfaces(surfaces: readonly SurfaceEntry[]): ReadonlyMap<string, SurfaceEntry> {
  const byId = new Map<string, SurfaceEntry>();
  for (const entry of surfaces) {
    if (byId.has(entry.id)) throw new Error(`generated surfaces list ${entry.id} twice`);
    byId.set(entry.id, entry);
  }
  return byId;
}
