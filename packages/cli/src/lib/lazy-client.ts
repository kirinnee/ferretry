/**
 * The client a verb or a tool is handed: built lazily, so a call that never reaches the daemon never reads a credential.
 * Its own module so the slim `mcp serve` entry can use it without the router (`run.ts`) and the command table.
 */
import type { Cancel } from '@ferretry/kernel/contract';
import type { PluginSocket } from '@ferretry/kernel/manifest';
import {
  type ClientDeps,
  type FollowingClient,
  pluginClient,
  routeFactsBeforeContact,
  socketFactsBeforeContact,
  toolFactsBeforeContact,
  type Surfaces,
} from './client.ts';
import { errorText } from './errors.ts';
import { buildRequest } from './request.ts';

/**
 * A `PluginClient` that builds the guarded client on its first call, for plugin verbs and shell verbs alike. The
 * route's own descriptor and the pane's standing are judged FIRST (S59): a person-only call from a ferret's pane is
 * refused before the daemon is probed, started or sent anything, as today's `refuseOwnerCommandInPane` refuses before
 * the gateway.
 */
export function lazyClient(
  deps: () => Promise<ClientDeps>,
  id: string,
  surfaces: Surfaces,
  paned: boolean,
): FollowingClient {
  const follow: FollowingClient['follow'] = (event, listener, onEnd) => {
    let cancel: Cancel | undefined;
    let stopped = false;
    // The connection opens when the first listener asks, like a call; a refusal to connect ends the feed with its words.
    void deps().then(
      opened => {
        if (stopped) return;
        try {
          cancel = pluginClient(opened, id).follow(event, listener, onEnd);
        } catch (error) {
          onEnd(errorText(error));
        }
      },
      (error: unknown) => {
        if (!stopped) onEnd(errorText(error));
      },
    );
    return () => {
      stopped = true;
      cancel?.();
    };
  };
  return {
    call: async (route, init) => {
      routeFactsBeforeContact(surfaces, paned, route);
      return await pluginClient(await deps(), id).call(route, init);
    },
    tool: async (name, input) => {
      toolFactsBeforeContact(surfaces, paned, name);
      return await pluginClient(await deps(), id).tool(name, input);
    },
    subscribe: (event, listener) => follow(event, listener, () => undefined),
    follow,
    socket: (key, params, listeners, query) => {
      // Declared and person-only checks come first and throw here, before the connection exists (S59).
      socketFactsBeforeContact(surfaces, paned, key);
      // A missing, unused or unsafe parameter fails the caller here, before the daemon is contacted, not through onClose.
      buildRequest(key, { params, ...(query === undefined ? {} : { query }) });
      let socket: PluginSocket | undefined;
      let closed = false;
      // The connection opens now, like a call; a refusal to connect ends the stream with its words.
      void deps().then(
        opened => {
          if (closed) return;
          try {
            socket = pluginClient(opened, id).socket(key, params, listeners, query);
          } catch (error) {
            listeners.onClose(errorText(error));
          }
        },
        (error: unknown) => {
          if (!closed) listeners.onClose(errorText(error));
        },
      );
      return {
        send: frame => socket?.send(frame),
        close: (code, reason) => {
          closed = true;
          socket?.close(code, reason);
        },
      };
    },
  };
}
