import type { PublicDoorHandle, PublicDoorPort } from '../contract/ports/public-door.ts';
import { PUBLIC_DOOR_PLUGINS } from '../contract/ports/public-door.ts';
import type { PluginId } from '../contract/ids.ts';
import { errorResponse } from '../contract/http.ts';
import type { CarrierListenerDeps } from './carrier-listener.ts';
import { toApiRequest, toResponse } from './listener.ts';
import { PermissionError } from './permissions.ts';

/** A rate-limit identity, never an authentication claim. All arrivals without a surface peer share this bucket. */
const PUBLIC_DOOR_SHARED_PEER = 'public-door';
const NOT_SERVED = errorResponse(404, 'nothing is served at this path', 'not_found');

/** The opener owns its public route table; the loopback forwarder's peer never supplies authority. */
export function publicDoorPort(deps: Omit<CarrierListenerDeps, 'daemonId'>): PublicDoorPort {
  const { manifest } = deps;
  const open = new Set<PublicDoorHandle>();
  let watching = false;
  return {
    open: async input => {
      if (
        manifest.permissions?.publicDoor !== true ||
        !(PUBLIC_DOOR_PLUGINS as readonly string[]).includes(manifest.id)
      )
        throw new PermissionError(`${manifest.id}: publicDoor is not permitted.`);
      if (deps.stopping()) throw new PermissionError(`${manifest.title} has stopped, so it cannot open a public door.`);
      if (!Number.isInteger(input.port) || input.port < 0 || input.port > 65535)
        throw new TypeError('a public door port must be an integer from 0 to 65535');
      if (!watching) {
        watching = true;
        deps.onStop(async () => {
          for (const handle of [...open]) await handle.close();
        });
      }
      const arrival = Object.freeze({ kind: 'door' as const, door: 'own' as const, plugin: manifest.id as PluginId });
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: input.port,
        fetch: async request => {
          try {
            if (request.headers.has('upgrade')) return toResponse(NOT_SERVED, false);
            const api = toApiRequest(request, arrival, undefined);
            const response = await deps.dispatcher().dispatch({
              ...api,
              clientAddress: input.peer?.(api.headers) ?? PUBLIC_DOOR_SHARED_PEER,
            });
            return toResponse(response, false);
          } catch {
            return toResponse(NOT_SERVED, false);
          }
        },
      });
      let closed = false;
      const handle: PublicDoorHandle = {
        port: server.port ?? 0,
        close: async () => {
          if (closed) return;
          closed = true;
          open.delete(handle);
          void server.stop(true);
        },
      };
      open.add(handle);
      return handle;
    },
  };
}
