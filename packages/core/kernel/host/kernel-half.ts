import type { InventoryEntry } from '../contract/bound.ts';
import type { ApiRequest } from '../contract/http.ts';
import { jsonResponse } from '../contract/http.ts';
import type { Health, PluginInventory } from '../contract/kernel.ts';
import { CORE_IDS } from '../contract/ids.ts';
import { PROTOCOL } from '../contract/session.ts';
import type { PostBuildSnapshot } from '../contract/snapshot.ts';
import type { RouteHandler } from '../contract/route.ts';
import type kernelManifest from '../plugin.ts';

type KernelRouteKey = NonNullable<(typeof kernelManifest)['actions']>['routes'][number]['key'];

export type { InventoryEntry };

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
