/**
 * TERMINALS OVER THE SHELL'S PER-DAEMON CLIENT (§9.6).
 *
 * In 5.0 a half talks to its daemon only through the client the shell builds for it: the client is already that one
 * daemon's, guarded by the inventory hash, and it reaches routes and sockets by their manifest KEY. These adapters
 * give today's deck and Settings tab what they were given before (their `dependencies` and `createClient`), calling
 * the same routes the same way, so the views themselves are unchanged.
 *
 * Every answer is parsed with the contract's schema before use, exactly as `web-terminals.ts` parses it.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { z } from 'zod';
import { TerminalIdSchema } from '../../contract/index.ts';
import type { TerminalDeckDependencies, TerminalDeckHost } from '../components/session-terminal-deck.tsx';
import type { TerminalSlotsClient } from '../features/settings/terminal-slots-api.ts';
import {
  closeSessionTerminal,
  createSessionTerminal,
  endSessionQuarantine,
  listSessionQuarantines,
  listSessionTerminals,
  renameSessionTerminal,
  TERMINAL_ROUTES,
  type TerminalStream,
  type TerminalStreamHandlers,
} from './web-terminals.ts';

/**
 * The close code a stream is handed to the deck as when the carrier reports none: the browser's own "abnormal
 * closure", which the deck's reopen policy retries with backoff, as it did for a dropped socket before. A code the
 * daemon DID end the stream with (`1008` and `1009` are its refusals) is handed over as it came and is final.
 */
export const STREAM_DROPPED_CODE = 1006;

/**
 * "This daemon is reachable again": the shell client's event feed going live (the client is already that one daemon's, so
 * the deck's `daemon` argument names nothing more). A pane waiting out its reopen backoff reopens at once.
 */
const recoveredOn =
  (feed: NonNullable<PluginClient['feed']>): NonNullable<TerminalDeckDependencies['onRecovered']> =>
  (_daemon, listener) =>
    feed.subscribeLive(live => {
      if (live) listener();
    });

/** Today's deck dependencies, over the shell client. */
export const pluginTerminalDeckDependencies = (
  client: PluginClient,
  host: TerminalDeckHost,
): TerminalDeckDependencies => ({
  list: (daemon, scope, options) => listSessionTerminals(client, daemon, scope, options),
  create: (daemon, scope) => createSessionTerminal(client, daemon, scope),
  rename: (daemon, scope, id, title) => renameSessionTerminal(client, daemon, scope, id, title),
  close: (daemon, scope, id) => closeSessionTerminal(client, daemon, scope, id),
  attach: async (_daemon, scope, terminalId, handlers) =>
    openPluginStream(client, scope.sessionId, TerminalIdSchema.parse(terminalId), handlers),
  ...(client.feed === undefined ? {} : { onRecovered: recoveredOn(client.feed) }),
  quarantines: (daemon, scope) => listSessionQuarantines(client, daemon, scope),
  endQuarantine: (daemon, scope, key) => endSessionQuarantine(client, daemon, scope, key),
  ...host,
});

/**
 * One terminal's stream as one socket on the shell client. Bytes are the shell's output; a text frame on this route
 * is the daemon speaking a shape this stream does not have, so it is dropped rather than drawn (today's rule).
 *
 * The viewer is told it is open when the daemon ACCEPTS the stream (a frame sent before is dropped), and told how it
 * closed with the stream's own code: a close the carrier reports without one is a drop and is retried.
 */
function openPluginStream(
  client: PluginClient,
  ferretId: string,
  terminalId: string,
  handlers: TerminalStreamHandlers,
): TerminalStream {
  if (client.socket === undefined) throw new Error('this client cannot open a terminal stream');
  const socket = client.socket(
    TERMINAL_ROUTES.stream,
    { ferretId, terminalId },
    {
      onOpen: () => handlers.onOpen(),
      onFrame: frame => {
        if (frame instanceof Uint8Array) handlers.onBytes(frame);
      },
      onClose: (reason, code) => handlers.onClosed(code ?? STREAM_DROPPED_CODE, reason),
    },
  );
  return {
    write: bytes => socket.send(bytes),
    control: text => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  };
}

const ROUTE_OF: Readonly<Record<string, string>> = {
  '/v1/terminals': TERMINAL_ROUTES.holders,
  '/v1/terminals/close-finished': TERMINAL_ROUTES.closeFinished,
  '/v1/cgroups/config': 'GET /v1/cgroups/config',
};

/** The Settings › Terminals client (`readTerminalHolders`, `closeFinishedTerminals`) over the shell client. */
export const pluginTerminalSlotsClient = (client: PluginClient): TerminalSlotsClient => ({
  request: async <T>(path: string, schema: z.ZodType<T>, init?: { readonly method?: string }): Promise<T> => {
    const route = ROUTE_OF[path];
    if (route === undefined || (init?.method ?? 'GET') !== route.split(' ')[0])
      throw new Error(`Terminals does not call ${init?.method ?? 'GET'} ${path}`);
    return schema.parse(await client.call(route));
  },
});
