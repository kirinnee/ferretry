/**
 * What every `manifest/actions/*.actions.ts` fragment shares: the one read policy, and the shape a fragment exports.
 *
 * A fragment is one feature's slice of the manifest's `actions` (routes, sockets, tools, verbs). The generator
 * (`scripts/gen/registries.ts`) lists every `manifest/actions/*.actions.ts` into the git-ignored
 * `manifest/generated/actions.ts` and `manifest.ts` spreads that, so a new route is an edit to one fragment (or a new
 * file) and no list is edited. The merged order is the file names sorted as plain strings, and a route's order is part of
 * its package's contract hash, so the numeric prefix is what keeps the routes in the order the manifest first declared
 * them: a new fragment takes a number that puts its routes where they belong, and a reorder changes the hash.
 */
import { CAPABILITIES } from '@ferretry/core-gate/contract';
import type { RouteDecl } from '@ferretry/kernel/manifest';
import { route } from '@ferretry/kernel/manifest';

/**
 * What a ferret read asks of a REMOTE caller: `fleet.use`, so a device the owner narrowed to no fleet use is refused with
 * `grant_device_not_granted` before anything is read (docs/grants.md). It is a device's gate only: a ferret's own credential is
 * never grant-governed (`presentation.local`), so an agent reads exactly what 4.x gave it, and the host's admin token
 * over loopback is ungoverned.
 */
export const FLEET_USE = { capability: CAPABILITIES.fleet, axis: 'use' } as const;

/**
 * What a ferret write that changes how the HOST behaves asks of a REMOTE caller (c58-sec3): `fleet.configure`, so a device
 * the owner narrowed to `--limited` (fleet use only) cannot start, fork, move, hand over, revoke or restart a ferret, and a
 * governed caller needs the live step-up like every other `configure` act. Like `FLEET_USE` it is a device's gate only.
 */
export const FLEET_CONFIGURE = { capability: CAPABILITIES.fleet, axis: 'configure' } as const;

type Descriptor = Parameters<typeof route>[1];

/** What a read route still says: its audit and guard declarations, and a `minimum` or `caller` that differs from the default. */
type ReadDescriptor = Omit<Descriptor, 'minimum' | 'caller' | 'capability' | 'noStore'> &
  Partial<Pick<Descriptor, 'minimum' | 'caller'>>;

/**
 * A ferret read (c58-sec1): `operator`, open to a ferret, `fleet.use` for a remote device, never cached. The whole policy
 * is this one function, so changing what a fleet read demands is one edit and no route is missed.
 */
export function ferretRead<const Key extends string>(key: Key, descriptor: ReadDescriptor): RouteDecl<Key> {
  return route(key, { minimum: 'operator', caller: 'any', capability: FLEET_USE, noStore: true, ...descriptor });
}

/** One feature's slice of the manifest: the plugin kit's `manifestFragment`, lifted to `@ferretry/kernel/manifest` (every plugin shares it). */
export { manifestFragment as fragment } from '@ferretry/kernel/manifest';
