/**
 * The runtime half of a plugin's feature kit: `composeFeatures` registers every feature of one package against one
 * shared context and merges what they serve into the sections the package's `build()` hands the kernel.
 *
 * A package keeps a folder of features (`daemon/features/<feature>.feature.ts`, or `<feature>/<feature>.feature.ts`), the
 * generator lists them into the git-ignored `daemon/generated/features.ts`, and the package's `daemon/index.ts` composes
 * the lot, so a feature that adds a route, a socket or a piece of the package's port adds one file and edits no list.
 */
import type { RouteHandler } from '../contract/route.ts';
import type { SocketAccept } from '../contract/socket.ts';

/** What one feature serves. Two features serving one key (or one port member) is a wiring fault. */
export interface FeatureContribution<Port> {
  readonly routes?: Readonly<Record<string, RouteHandler>>;
  readonly sockets?: Readonly<Record<string, SocketAccept>>;
  /** Members this feature adds to the package's port, merged into the one a needer is handed. */
  readonly port?: Partial<Port>;
}

/** One feature of a package: an id (unique, named in a wiring fault) and the registration against the shared context. */
export interface ComposableFeature<Ctx, Port> {
  readonly id: string;
  readonly register: (context: Ctx) => FeatureContribution<Port> | undefined;
}

/** What every registered feature serves, merged: the sections `build()` hands the kernel. */
export interface ComposedFeatures<Port> {
  readonly routes: Readonly<Record<string, RouteHandler>>;
  readonly sockets: Readonly<Record<string, SocketAccept>>;
  readonly port: Partial<Port>;
}

/**
 * Registers every feature, in the order given, against one shared context and merges what they serve. A key two features
 * both serve, a port member two features both add, or two features with one id is a wiring fault: it throws at boot,
 * naming both (prefixed with the package's `label`), rather than letting the later one win silently.
 */
export function composeFeatures<Ctx, Port>(
  label: string,
  features: readonly ComposableFeature<Ctx, Port>[],
  context: Ctx,
): ComposedFeatures<Port> {
  const routes: Record<string, RouteHandler> = {};
  const sockets: Record<string, SocketAccept> = {};
  const port: Record<string, unknown> = {};
  const owners = new Map<string, string>();
  const claim = (kind: string, key: string, feature: string): void => {
    const slot = `${kind} ${key}`;
    const held = owners.get(slot);
    if (held !== undefined) throw new Error(`${label}: the features ${held} and ${feature} both serve ${slot}`);
    owners.set(slot, feature);
  };
  const ids = new Set<string>();
  for (const feature of features) {
    if (ids.has(feature.id)) throw new Error(`${label}: two features are called ${feature.id}`);
    ids.add(feature.id);
    const served = feature.register(context);
    if (served === undefined) continue;
    for (const [key, handler] of Object.entries(served.routes ?? {})) {
      claim('route', key, feature.id);
      routes[key] = handler;
    }
    for (const [key, accept] of Object.entries(served.sockets ?? {})) {
      claim('socket', key, feature.id);
      sockets[key] = accept;
    }
    for (const [key, member] of Object.entries(served.port ?? {})) {
      claim('port member', key, feature.id);
      port[key] = member;
    }
  }
  return { routes, sockets, port: port as Partial<Port> };
}
