import {
  CORE_IDS,
  PROTOCOL,
  type PluginInventory,
  type RouteDescriptor,
  type ScopedRoute,
} from '@ferretry/kernel/contract';
import { type CapabilityGrants, coreCapabilityName } from './policy.ts';

/**
 * `GET /v1/plugins` is the Kernel's route with a Gate descriptor (§9.6, review r13 finding 3): any credential, no
 * capability, served before the unlock (the app needs it to draw the unlock screen), audit skipped, no-store.
 * Gate projects the answer per standing so a limited device cannot discover what it may not use.
 */
export const PLUGIN_INVENTORY_DESCRIPTOR: RouteDescriptor = Object.freeze({
  method: 'GET',
  path: '/v1/plugins',
  minimum: 'authenticated',
  caller: 'any',
  unlockExempt: true,
  audit: { skip: 'a read of which plugins are on and their contract hashes; no security act' },
  guard: { none: 'plugin ids, on/off flags and contract hashes; no pane, page or vault text' },
  noStore: true,
});

/** Who is reading the inventory, as Gate's standing says (§9.6 table). */
export type InventoryViewer =
  | { readonly kind: 'owner' } // the admin token on the host
  | { readonly kind: 'ferret' } // a `fys_` token
  | { readonly kind: 'device'; readonly grants: CapabilityGrants } // effective grants: daemon-wide ∧ device
  | { readonly kind: 'warden' }
  | { readonly kind: 'member' }
  | { readonly kind: 'none' };

/** Every declared route, socket and agent tool of one plugin, as descriptors. */
export type PluginSurfaces = ReadonlyMap<string, readonly Omit<ScopedRoute, 'method' | 'path'>[]>;

export type InventoryProjection =
  | { readonly outcome: 'shown'; readonly inventory: PluginInventory }
  | { readonly outcome: 'refused'; readonly status: 401 | 403 };

/**
 * Whether a device's grants admit one surface, ignoring the unlock (§9.6): reachable by a device credential at all
 * (not `admin-token`, not `privilegedOnly`, not a person route it could not reach) and, when governed, granted on the
 * axis it demands. An unknown capability is not admitted (fail closed).
 */
export function deviceAdmits(surface: Omit<ScopedRoute, 'method' | 'path'>, grants: CapabilityGrants): boolean {
  if (surface.minimum === 'admin-token' || surface.privilegedOnly === true) return false;
  const demand = surface.capability;
  if (demand === undefined) return true;
  const name = coreCapabilityName(demand.capability);
  if (name === undefined) return false;
  const grant = grants[name];
  return demand.axis === 'use' ? grant.use : grant.use && grant.configure;
}

const DEVICE_ALWAYS: readonly string[] = [...CORE_IDS, 'access'];
const WARDEN_SEES: readonly string[] = [...CORE_IDS, 'warden'];

/**
 * The per-standing projection of `GET /v1/plugins` (§9.6): the owner and a ferret see every package; a device sees the
 * core pieces, Access, and each plugin with at least one surface its grants admit; the remote warden sees the core
 * pieces and Warden; a member is refused 403 on the main table; no principal is refused 401. Pure.
 */
export function projectInventory(
  inventory: PluginInventory,
  viewer: InventoryViewer,
  surfaces: PluginSurfaces,
): InventoryProjection {
  const keep = (predicate: (id: string) => boolean): InventoryProjection => ({
    outcome: 'shown',
    inventory: { protocol: PROTOCOL, plugins: inventory.plugins.filter(entry => predicate(entry.id)) },
  });
  switch (viewer.kind) {
    case 'owner':
    case 'ferret':
      return keep(() => true);
    case 'warden':
      return keep(id => WARDEN_SEES.includes(id));
    case 'device':
      return keep(
        id => DEVICE_ALWAYS.includes(id) || (surfaces.get(id) ?? []).some(surface => deviceAdmits(surface, viewer.grants)),
      );
    case 'member':
      return { outcome: 'refused', status: 403 };
    case 'none':
      return { outcome: 'refused', status: 401 };
  }
}
