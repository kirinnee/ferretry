import type { Server } from 'bun';
import { Carriers } from '../contract/kernel.ts';
import { errorResponse, headersFrom } from '../contract/http.ts';
import type { PluginId } from '../contract/ids.ts';
import type { CarrierKey } from '../contract/ids.ts';
import type { CarrierListenerHandle, CarrierListenerPort, CarrierListenerSurface } from '../contract/ports.ts';
import type { CarriedArrival } from '../contract/session.ts';
import type { Manifest } from '../manifest/types.ts';
import type { Dispatcher } from './dispatch.ts';
import { PermissionError } from './permissions.ts';
import { Router } from './router.ts';
import { type SocketData, socketBehaviour, toApiRequest, toResponse } from './listener.ts';

/** The one rate-limit identity every arrival without a surface `peer` shares: hiding it buys no bucket of one's own. */
export const CARRIER_SHARED_PEER = 'carrier';

/** Everything else on a carrier listener is not served, and says nothing about what is. */
const NOT_SERVED = errorResponse(404, 'nothing is served at this path', 'not_found');

export interface CarrierListenerDeps {
  readonly manifest: Manifest;
  /** Read at each request: the dispatcher is built after the plugins, and a listener is opened after that. */
  readonly dispatcher: () => Dispatcher;
  /** `fy_daemon_…`: the only `:daemonId` the served route answers to. */
  readonly daemonId: string;
  /** Stopping the plugin (or the daemon) closes every listener it still holds. */
  readonly onStop: (fn: () => void | Promise<void>) => void;
}

/**
 * The kernel's carrier listener (§2.3, G15, G16): today's tunnel listener, owned by the kernel instead of bound around
 * it. A forwarder on this host (the tunnel's `cloudflared`) makes every arrival come from a loopback peer, so it must
 * never be pointed at the API listener; it is pointed here, where
 *
 * - only the plugin's DECLARED socket route is served (`GET /v1/rendezvous/<this daemon>/client`), through the same
 *   dispatcher and the same admission as the direct carrier's, and 404 answers every other path and method;
 * - every arrival is stamped `{ kind: 'carried', carrier }` and never local, whatever its peer address says (the
 *   socket's own peer is not even read: it is the forwarder), so admission governs it as remote (`arrivedOnHost` false);
 * - the rate-limit identity is the surface's `peer` of the headers, else one shared identity.
 *
 * A plugin may open one only for a carrier whose hook it takes and a socket it declares.
 */
export function carrierListenerPort(deps: CarrierListenerDeps): CarrierListenerPort {
  const { manifest } = deps;
  const plugin = manifest.id as PluginId;
  const open = new Set<CarrierListenerHandle>();
  let watching = false;
  return {
    open: async ({ carrier, surface }) => {
      const declared = declaredSocket(manifest, carrier, surface);
      if (!watching) {
        watching = true;
        deps.onStop(async () => {
          for (const handle of [...open]) await handle.close();
        });
      }
      const served = new Router([declared]);
      const arrival: CarriedArrival = Object.freeze({ kind: 'carried', carrier });
      const server: Server<SocketData> = Bun.serve<SocketData>({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request, bound) => {
          try {
            const notServed = (): Response => toResponse(NOT_SERVED, false);
            if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
              return notServed();
            const api = toApiRequest(request, arrival, undefined);
            const route = served.lookup(api.method, api.path);
            if (route.kind !== 'matched') return notServed();
            const asked = route.params.get('daemonId');
            if (asked !== undefined && asked !== deps.daemonId) return notServed();
            const dispatcher = deps.dispatcher();
            const claim = dispatcher.socketClaim(api);
            if (claim?.plugin !== plugin || claim.method !== declared.method || claim.path !== declared.path)
              return notServed();
            const stamped = {
              ...api,
              arrival,
              clientAddress: surface.peer?.(headersFrom(Object.fromEntries(request.headers))) ?? CARRIER_SHARED_PEER,
            };
            const decision = await dispatcher.upgrade(stamped);
            if (decision.outcome === 'refused') return toResponse(decision.response, false);
            if (decision.outcome !== 'accepted') return notServed();
            const data: SocketData = { pending: [], closed: false, attach: decision.attach };
            return bound.upgrade(request, { data }) ? undefined : toResponse(NOT_SERVED, false);
          } catch {
            return toResponse(NOT_SERVED, false);
          }
        },
        websocket: socketBehaviour,
      });
      let closed = false;
      const handle: CarrierListenerHandle = {
        port: server.port ?? 0,
        close: async () => {
          if (closed) return;
          closed = true;
          open.delete(handle);
          // Bun releases the address synchronously; the returned promise may never settle once the server itself
          // closed a socket, so shutdown never waits on it.
          void server.stop(true);
        },
      };
      open.add(handle);
      return handle;
    },
  };
}

/**
 * The route this plugin may serve for this carrier, or a refusal. The carrier must be one the plugin takes the hook of
 * and the socket one its manifest declares (a `GET`: only an upgrade is ever served).
 */
function declaredSocket(
  manifest: Manifest,
  carrier: CarrierKey,
  surface: CarrierListenerSurface,
): { readonly method: string; readonly path: string } {
  const takesCarrier = (manifest.hooks?.takes ?? []).some(
    take => take.hook.name === Carriers.name && take.key === carrier,
  );
  if (!takesCarrier)
    throw new PermissionError(
      `${manifest.title} does not declare the ${String(carrier)} carrier, so it cannot open a listener for it.`,
    );
  const socket = (manifest.actions?.sockets ?? []).find(decl => decl.key === surface.socket);
  if (socket === undefined || socket.method.toUpperCase() !== 'GET')
    throw new PermissionError(
      `${manifest.title} does not declare the socket ${surface.socket}, so a carrier listener cannot serve it.`,
    );
  return { method: socket.method, path: socket.path };
}
