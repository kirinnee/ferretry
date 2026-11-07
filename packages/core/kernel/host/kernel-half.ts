import type { InventoryEntry, InventorySurfaces } from '../contract/bound.ts';
import type { ApiRequest } from '../contract/http.ts';
import { jsonResponse } from '../contract/http.ts';
import type { Health, PluginInventory } from '../contract/kernel.ts';
import { CORE_IDS } from '../contract/ids.ts';
import { PROTOCOL } from '../contract/session.ts';
import type { PostBuildSnapshot } from '../contract/snapshot.ts';
import type { RouteHandler, ScopedRoute } from '../contract/route.ts';
import type { Manifest } from '../manifest/types.ts';
import type kernelManifest from '../plugin.ts';

type KernelRouteKey = NonNullable<(typeof kernelManifest)['actions']>['routes'][number]['key'];

export type { InventoryEntry, InventorySurfaces };

/**
 * One plugin's declared surfaces for the inventory projection (§9.6): every route, socket and agent tool, as the
 * descriptor admission reads (method and path dropped). Read from the manifest only, so a plugin that is off still
 * has its declarations (the entry's `on` says whether it serves).
 */
export function inventorySurfacesOf(manifest: Manifest): readonly Omit<ScopedRoute, 'method' | 'path'>[] {
  const scope = ({ method: _method, path: _path, ...rest }: ScopedRoute): Omit<ScopedRoute, 'method' | 'path'> => rest;
  return [
    ...(manifest.actions?.routes ?? []).map(scope),
    ...(manifest.actions?.sockets ?? []).map(scope),
    ...(manifest.actions?.agentTools ?? []),
  ];
}

export interface KernelHalfSources {
  readonly version: string;
  inventory(): readonly InventoryEntry[];
  /** Gate's per-standing projection (§9.6). `undefined` (no Gate, or it threw) = only the five core pieces. */
  project(request: ApiRequest, entries: readonly InventoryEntry[]): readonly InventoryEntry[] | undefined;
  snapshot(): PostBuildSnapshot;
  liveness(): { readonly status: 'starting' | 'ok'; readonly uptimeSeconds: number; readonly pid: number };
}

/** The kernel's own routes (§9.6, §1.3). Their descriptors are in `plugin.ts`. */
export function kernelRoutes(sources: KernelHalfSources): Readonly<Record<KernelRouteKey, RouteHandler>> {
  return {
    'GET /v1/health': async () => jsonResponse({ protocol: PROTOCOL, version: sources.version } satisfies Health),
    'GET /healthz': async () => {
      const live = sources.liveness();
      return jsonResponse(
        { ...live, version: sources.version, protocol: PROTOCOL },
        live.status === 'starting' ? 503 : 200,
      );
    },
    'GET /v1/plugins': async call => {
      const entries = sources.inventory();
      const projected =
        sources.project(call.request, entries) ??
        entries.filter(entry => (CORE_IDS as readonly string[]).includes(entry.id));
      return jsonResponse({
        protocol: PROTOCOL,
        plugins: projected.map(entry => ({ id: entry.id, on: entry.on, contract: entry.contract })),
      } satisfies PluginInventory);
    },
    'GET /v1/glossary': async () =>
      jsonResponse({
        words: sources.snapshot().words.map(word => ({
          word: word.word,
          means: word.means,
          plugin: word.plugin,
          ...(word.insteadOf === undefined ? {} : { insteadOf: [...word.insteadOf] }),
        })),
      }),
  };
}
