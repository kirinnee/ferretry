import type { RouteHandler, SocketAccept } from '@ferretry/kernel/contract';
import type { FerretsApi } from '../../contract/index.ts';
import type { FerretsContext, FerretsFeature } from './types.ts';

/** What every registered feature serves, merged: the sections `build()` hands the kernel. */
export interface ComposedFeatures {
  readonly routes: Readonly<Record<string, RouteHandler>>;
  readonly sockets: Readonly<Record<string, SocketAccept>>;
  /** The members features add to the Ferrets port, merged into the one a needer is handed. */
  readonly port: Partial<FerretsApi>;
}

/**
 * Registers every feature, in the order given, against one shared composition and merges what they serve. A key two
 * features both serve, a port member two features both add, or two features with one id is a wiring fault: it throws at
 * boot, naming both, rather than letting the later one win silently.
 */
export function registerFeatures(features: readonly FerretsFeature[], context: FerretsContext): ComposedFeatures {
  const routes: Record<string, RouteHandler> = {};
  const sockets: Record<string, SocketAccept> = {};
  const port: Record<string, unknown> = {};
  const owners = new Map<string, string>();
  const claim = (kind: string, key: string, feature: string): void => {
    const slot = `${kind} ${key}`;
    const held = owners.get(slot);
    if (held !== undefined) throw new Error(`ferrets: the features ${held} and ${feature} both serve ${slot}`);
    owners.set(slot, feature);
  };
  const ids = new Set<string>();
  for (const feature of features) {
    if (ids.has(feature.id)) throw new Error(`ferrets: two features are called ${feature.id}`);
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
  return { routes, sockets, port: port as Partial<FerretsApi> };
}
