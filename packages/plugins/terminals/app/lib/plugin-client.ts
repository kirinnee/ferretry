/**
 * TERMINALS OVER THE SHELL'S PER-DAEMON CLIENT (§9.6).
 *
 * In 5.0 a half talks to its daemon only through the client the shell builds for it: the client is already that one
 * daemon's, guarded by the inventory hash, and it reaches routes and sockets by their manifest KEY. These adapters
 * give today's deck and Settings tab what they were given before (their `dependencies` and `createClient`), calling
 * the same routes the same way, so the views themselves are unchanged.
 *
 * Every answer is parsed with the contract's schema before use, exactly as `web-terminals.ts` parsed it.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { z } from 'zod';
import {
  CloseTerminalResponseSchema,
  RenameTerminalRequestSchema,
  TerminalIdSchema,
  TerminalListViewSchema,
  TerminalViewSchema,
} from '../../contract/index.ts';
import type { TerminalDeckDependencies, TerminalDeckHost } from '../components/session-terminal-deck.tsx';
import type { TerminalSlotsClient } from '../features/settings/terminal-slots-api.ts';
import type { TerminalStream, TerminalStreamHandlers } from './web-terminals.ts';

/** The shell's client widens the leaf's with sockets (`ShellPluginClient`); a client without them cannot stream. */
interface SocketListeners {
  readonly onFrame: (frame: string | Uint8Array) => void;
  readonly onClose: (reason: string) => void;
}
interface ClientSocket {
  send(frame: string | Uint8Array): void;
  close(): void;
}
export interface SocketPluginClient extends PluginClient {
  socket(key: string, params: Readonly<Record<string, string>>, listeners: SocketListeners): ClientSocket;
}

const canStream = (client: PluginClient): client is SocketPluginClient =>
  typeof (client as Partial<SocketPluginClient>).socket === 'function';

export const TERMINAL_ROUTES = {
  holders: 'GET /v1/terminals',
  closeFinished: 'POST /v1/terminals/close-finished',
  list: 'GET /v1/ferrets/:ferretId/terminals',
  create: 'POST /v1/ferrets/:ferretId/terminals',
  rename: 'PATCH /v1/ferrets/:ferretId/terminals/:terminalId',
  close: 'DELETE /v1/ferrets/:ferretId/terminals/:terminalId',
  stream: 'GET /v1/ferrets/:ferretId/terminals/:terminalId/stream',
} as const;

/**
 * The close code a carrier drop is handed to the deck as: the browser's own "abnormal closure", which the deck's
 * reopen policy retries with backoff, as it did for a dropped socket before.
 */
export const STREAM_DROPPED_CODE = 1006;

/** Today's deck dependencies, over the shell client. Holds (quarantines) are Vault's routes and are not listed here. */
export const pluginTerminalDeckDependencies = (
  client: PluginClient,
  host: TerminalDeckHost,
): TerminalDeckDependencies => ({
  list: async (_daemon, scope) =>
    TerminalListViewSchema.parse(await client.call(TERMINAL_ROUTES.list, { params: { ferretId: scope.sessionId } })),
  create: async (_daemon, scope) =>
    TerminalViewSchema.parse(
      await client.call(TERMINAL_ROUTES.create, { params: { ferretId: scope.sessionId }, body: {} }),
    ),
  rename: async (_daemon, scope, id, title) =>
    TerminalViewSchema.parse(
      await client.call(TERMINAL_ROUTES.rename, {
        params: { ferretId: scope.sessionId, terminalId: TerminalIdSchema.parse(id) },
        body: RenameTerminalRequestSchema.parse({ title }),
      }),
    ),
  close: async (_daemon, scope, id) =>
    CloseTerminalResponseSchema.parse(
      await client.call(TERMINAL_ROUTES.close, {
        params: { ferretId: scope.sessionId, terminalId: TerminalIdSchema.parse(id) },
      }),
    ),
  attach: async (_daemon, scope, terminalId, handlers) =>
    openPluginStream(client, scope.sessionId, TerminalIdSchema.parse(terminalId), handlers),
  ...host,
});

/**
 * One terminal's stream as one socket on the shell client. Bytes are the shell's output; a text frame on this route
 * is the daemon speaking a shape this stream does not have, so it is dropped rather than drawn (today's rule).
 */
export function openPluginStream(
  client: PluginClient,
  ferretId: string,
  terminalId: string,
  handlers: TerminalStreamHandlers,
): TerminalStream {
  if (!canStream(client)) throw new Error('this client cannot open a terminal stream');
  const socket = client.socket(
    TERMINAL_ROUTES.stream,
    { ferretId, terminalId },
    {
      onFrame: frame => {
        if (frame instanceof Uint8Array) handlers.onBytes(frame);
      },
      onClose: reason => handlers.onClosed(STREAM_DROPPED_CODE, reason),
    },
  );
  handlers.onOpen();
  return {
    write: bytes => socket.send(bytes),
    control: text => socket.send(text),
    close: () => socket.close(),
  };
}

const ROUTE_OF: Readonly<Record<string, string>> = {
  '/v1/terminals': TERMINAL_ROUTES.holders,
  '/v1/terminals/close-finished': TERMINAL_ROUTES.closeFinished,
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
