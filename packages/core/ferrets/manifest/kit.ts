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
import type { RouteDecl, SocketDecl, ToolDecl, VerbDecl } from '@ferretry/kernel/manifest';
import { route } from '@ferretry/kernel/manifest';

/**
 * What a ferret read asks of a REMOTE caller: `fleet.use`, so a device the owner narrowed to no fleet use is refused with
 * `grant_device_not_granted` before anything is read (docs/grants.md). It is a device's gate only: a ferret's own credential is
 * never grant-governed (`presentation.local`), so an agent reads exactly what 4.x gave it, and the host's admin token
 * over loopback is ungoverned.
 */
export const FLEET_USE = { capability: CAPABILITIES.fleet, axis: 'use' } as const;

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

/** One fragment's slice of `actions`; a kind it does not declare is empty, so the merged lists are always whole. */
interface Fragment<
  Routes extends readonly RouteDecl[],
  Sockets extends readonly SocketDecl[],
  Tools extends readonly ToolDecl[],
  Verbs extends readonly VerbDecl[],
> {
  readonly routes: Routes;
  readonly sockets: Sockets;
  readonly agentTools: Tools;
  readonly cli: Verbs;
}

/** Keeps every literal (route keys, tool names, verb lines) so the merged `actions` types the halves exactly as one literal did. */
export function fragment<
  const Routes extends readonly RouteDecl[] = readonly [],
  const Sockets extends readonly SocketDecl[] = readonly [],
  const Tools extends readonly ToolDecl[] = readonly [],
  const Verbs extends readonly VerbDecl[] = readonly [],
>(parts: {
  readonly routes?: Routes;
  readonly sockets?: Sockets;
  readonly agentTools?: Tools;
  readonly cli?: Verbs;
}): Fragment<Routes, Sockets, Tools, Verbs> {
  return {
    routes: parts.routes ?? ([] as unknown as Routes),
    sockets: parts.sockets ?? ([] as unknown as Sockets),
    agentTools: parts.agentTools ?? ([] as unknown as Tools),
    cli: parts.cli ?? ([] as unknown as Verbs),
  };
}
