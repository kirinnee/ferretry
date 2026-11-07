/**
 * TERMINALS OVER THE SHELL'S PER-DAEMON CLIENT (§9.6).
 *
 * In 5.0 a half talks to its daemon only through the client the shell builds for it: the client is already that one
 * daemon's, is guarded by the contract hash before every call, subscription and socket, and reaches routes and sockets
 * by their manifest KEY. So nothing here takes a daemon: the half is built once per daemon, and "which daemon" is
 * answered by whichever client it was given — a session id reused across two daemons can never resolve to the wrong one.
 *
 * Every answer is parsed with the contract's schema before use, and an answer about another ferret or another terminal
 * than the one asked for is damaged evidence, refused whole (today's rule, unchanged).
 */

import { DaemonCallError, type SocketListeners, type TransportSocket } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type CloseTerminalResponse,
  CloseTerminalResponseSchema,
  type CreateTerminalRequest,
  CreateTerminalRequestSchema,
  RenameTerminalRequestSchema,
  TerminalIdSchema,
  type TerminalListView,
  TerminalListViewSchema,
  type TerminalView,
  TerminalViewSchema,
} from '../../contract/index.ts';
import { type InputQuarantineList, InputQuarantineListSchema } from './protocol/holds.ts';
import {
  SESSION_CONSOLE_INPUT_MAX,
  SessionConsoleInputRequestSchema,
  SessionConsoleInputResultSchema,
} from './protocol/session-processes.ts';

/**
 * Whose terminals: the ferret (the wire still calls it a session) on the one daemon this half is built for.
 *
 * There is no daemon here on purpose. The shell builds one half per daemon and hands it that daemon's own client.
 */
export interface TerminalScope {
  readonly sessionId: string;
}

/** The routes this half calls, by manifest key. Vault's holds routes are the hold list and its `end`. */
export const TERMINAL_ROUTES = {
  holders: 'GET /v1/terminals',
  closeFinished: 'POST /v1/terminals/close-finished',
  list: 'GET /v1/ferrets/:ferretId/terminals',
  create: 'POST /v1/ferrets/:ferretId/terminals',
  rename: 'PATCH /v1/ferrets/:ferretId/terminals/:terminalId',
  close: 'DELETE /v1/ferrets/:ferretId/terminals/:terminalId',
  stream: 'GET /v1/ferrets/:ferretId/terminals/:terminalId/stream',
  consoleInput: 'POST /v1/ferrets/:ferretId/console/input',
  quarantines: 'GET /v1/ferrets/:ferretId/input-quarantines',
  endQuarantine: 'POST /v1/ferrets/:ferretId/input-quarantines/:key/end',
} as const;

/** The code a daemon-side mismatch is raised with: the daemon answered, but about something else. */
const MISMATCH_CODE = 'daemon_mismatch';

const mismatch = (message: string): DaemonCallError => new DaemonCallError(502, MISMATCH_CODE, message);

/**
 * Terminal identity is daemon-issued and lands in a URL path, so it is parsed
 * before use rather than trusted from whichever view supplied it.
 */
const terminalParams = (scope: TerminalScope, terminalId: string) => ({
  ferretId: scope.sessionId,
  terminalId: TerminalIdSchema.parse(terminalId),
});

const parseTerminal = (scope: TerminalScope, body: unknown): TerminalView => {
  const view = TerminalViewSchema.parse(body);
  if (view.sessionId !== scope.sessionId) throw mismatch('daemon returned another session');
  return view;
};

/** Lists the terminals the daemon owns for one of its ferrets. */
export const listSessionTerminals = async (client: PluginClient, scope: TerminalScope): Promise<TerminalListView> => {
  const list = TerminalListViewSchema.parse(
    await client.call(TERMINAL_ROUTES.list, { params: { ferretId: scope.sessionId } }),
  );
  if (list.sessionId !== scope.sessionId) throw mismatch('daemon listed another session');
  return list;
};

/** Opens a terminal, letting the daemon choose any size the caller omits. */
export const createSessionTerminal = async (
  client: PluginClient,
  scope: TerminalScope,
  request: CreateTerminalRequest = {},
): Promise<TerminalView> =>
  parseTerminal(
    scope,
    await client.call(TERMINAL_ROUTES.create, {
      params: { ferretId: scope.sessionId },
      body: CreateTerminalRequestSchema.parse(request),
    }),
  );

/** Retitles one terminal on the daemon that owns it. */
export const renameSessionTerminal = async (
  client: PluginClient,
  scope: TerminalScope,
  terminalId: string,
  title: string,
): Promise<TerminalView> =>
  parseTerminal(
    scope,
    await client.call(TERMINAL_ROUTES.rename, {
      params: terminalParams(scope, terminalId),
      body: RenameTerminalRequestSchema.parse({ title }),
    }),
  );

/** Closes one terminal, confirming the daemon closed the one that was asked for. */
export const closeSessionTerminal = async (
  client: PluginClient,
  scope: TerminalScope,
  terminalId: string,
): Promise<CloseTerminalResponse> => {
  const closed = CloseTerminalResponseSchema.parse(
    await client.call(TERMINAL_ROUTES.close, { params: terminalParams(scope, terminalId) }),
  );
  if (closed.id !== terminalId) throw mismatch('daemon closed another terminal');
  return closed;
};

/** Lists the terminals of a ferret that were just handed a secret and are held from the agent (Vault's holds). */
export const listSessionQuarantines = async (
  client: PluginClient,
  scope: TerminalScope,
): Promise<InputQuarantineList> =>
  InputQuarantineListSchema.parse(
    await client.call(TERMINAL_ROUTES.quarantines, { params: { ferretId: scope.sessionId } }),
  );

/** Ends one quarantine early, by the terminal's key or id; the daemon audits who ended it. */
export const endSessionQuarantine = async (client: PluginClient, scope: TerminalScope, key: string): Promise<void> => {
  const body = await client.call<{ ended?: unknown } | null>(TERMINAL_ROUTES.endQuarantine, {
    params: { ferretId: scope.sessionId, key },
  });
  if (body?.ended !== true) throw mismatch('daemon did not end the quarantine');
};

/**
 * Splits input into writes the daemon accepts, never between the two halves of a surrogate pair — a
 * paste of emoji cut there would type two replacement characters into the agent's pane.
 */
export const consoleInputChunks = (data: string, max = SESSION_CONSOLE_INPUT_MAX): readonly string[] => {
  const chunks: string[] = [];
  let current = '';
  for (const character of data) {
    if (current.length + character.length > max) {
      chunks.push(current);
      current = '';
    }
    current += character;
  }
  if (current !== '') chunks.push(current);
  return chunks;
};

/**
 * Types into the ferret's OWN pane — the Console — on the daemon that owns it.
 *
 * Governed as a terminal is (`terminal.use`): a paired device needs the grant and its unlock, and a
 * refusal comes back as the same grant error a terminal open would raise. A long paste is sent as
 * ordered writes, each one awaited, so the pane receives it in the order it was typed.
 */
export const typeIntoSessionConsole = async (
  client: PluginClient,
  scope: TerminalScope,
  data: string,
): Promise<number> => {
  let written = 0;
  for (const chunk of consoleInputChunks(data)) {
    const body = await client.call(TERMINAL_ROUTES.consoleInput, {
      params: { ferretId: scope.sessionId },
      body: SessionConsoleInputRequestSchema.parse({ data: chunk }),
    });
    written += SessionConsoleInputResultSchema.parse(body).written;
  }
  return written;
};

/* ---------- one terminal stream, on the shell's guarded socket ------------- */

/**
 * The live half of a terminal, as the three things a viewer does with one.
 *
 * A PORT RATHER THAN A SOCKET: the deck asks for these operations and nothing above this line knows which carrier
 * (direct or a rendezvous) the shell chose to carry them.
 */
export interface TerminalStream {
  /** Raw keystrokes and pastes. The session splits an oversized write at the carrier's record budget. */
  write(bytes: Uint8Array): void;
  /** One complete control frame — a resize. Never split, because half a message is corruption. */
  control(text: string): void;
  /** Leave deliberately. */
  close(code: number, reason: string): void;
}

/**
 * What a viewer is told about its stream.
 *
 * `refused` is separate from `closed` because a refusal is the daemon's final verdict ("it is gone", "not allowed"):
 * a viewer that retried a `403` would ask a permanent refusal the same question forever. `closed` is a stream that
 * ended for a reason neither side chose, which the deck reopens with backoff.
 */
export interface TerminalStreamHandlers {
  onOpen(): void;
  onBytes(bytes: Uint8Array): void;
  onClosed(code: number, reason: string): void;
  onRefused(status: number, body: string): void;
}

/** `reveal` asks the daemon to show THIS viewer a held terminal (I77). It is per connection and audited by the daemon. */
export interface TerminalAttachOptions {
  readonly reveal?: boolean;
}

export type TerminalStreamAttach = (
  scope: TerminalScope,
  terminalId: string,
  handlers: TerminalStreamHandlers,
  options?: TerminalAttachOptions,
) => Promise<TerminalStream>;

/** The shell's client widens the leaf's with sockets (`ShellPluginClient`); a client without them cannot stream. */
export interface SocketPluginClient extends PluginClient {
  socket(
    key: string,
    params: Readonly<Record<string, string>>,
    listeners: SocketListeners,
    query?: Readonly<Record<string, string>>,
  ): TransportSocket;
  /** "This daemon is reachable again" — present on the shell's client; see {@link terminalRecovery}. */
  onReconnect?(listener: () => void): () => void;
}

const canStream = (client: PluginClient): client is SocketPluginClient =>
  typeof (client as Partial<SocketPluginClient>).socket === 'function';

/**
 * "This daemon is reachable again", for a pane waiting out its reopen backoff. Absent on a client that cannot say,
 * and the pane then waits out the backoff, as it does for any client without the signal.
 */
export const terminalRecovery = (client: PluginClient): ((listener: () => void) => () => void) | undefined => {
  const reconnect = (client as Partial<SocketPluginClient>).onReconnect;
  return typeof reconnect === 'function' ? listener => reconnect.call(client, listener) : undefined;
};

/**
 * The close code of a stream that ended without the daemon's own: a carrier that dropped, a plugin that was paused.
 * It is the browser's "abnormal closure", which the deck's reopen policy retries with backoff.
 */
export const STREAM_DROPPED_CODE = 1006;

/**
 * Attaches to one terminal as one socket on the shell client.
 *
 * Bytes are the shell's output. TEXT ON THIS ROUTE IS THE DAEMON SPEAKING A SHAPE THIS STREAM DOES NOT HAVE — the
 * terminal's text direction is client-to-daemon, for the resize control — so it is dropped rather than written into
 * the emulator, because writing it would put the daemon's own JSON on the reader's screen as if the shell had
 * printed it.
 *
 * THE VIEWER SEES WHAT THE DAEMON DRAWS AND NOTHING ELSE. The route is opened with the ferret and the terminal and, only
 * when the reader pressed "Show anyway", `?reveal=1` (I77): the daemon decides, audits it, and may refuse. Without it
 * the masked cells (and, while the terminal is held, the daemon's notice in their place) are all that can arrive.
 */
export const terminalStreamAttach =
  (client: PluginClient): TerminalStreamAttach =>
  async (scope, terminalId, handlers, options = {}) => {
    if (!canStream(client)) throw new Error('this client cannot open a terminal stream');
    let over = false;
    const socket = client.socket(
      TERMINAL_ROUTES.stream,
      terminalParams(scope, terminalId),
      {
        onFrame: frame => {
          if (!over && frame instanceof Uint8Array) handlers.onBytes(frame);
        },
        // LIVE ONLY ONCE IT OPENS: the shell says so when the daemon accepts the stream, never before.
        onOpen: () => {
          if (!over) handlers.onOpen();
        },
        onClose: (reason, detail) => {
          if (over) return;
          over = true;
          // The daemon's refusal is final for this attempt (its status and body, as sent); anything else carries
          // the stream's own close code when there was one, so a policy close (1008/1009) or a deliberate end
          // (1000) is told apart from a drop.
          if (detail?.refusedStatus !== undefined) handlers.onRefused(detail.refusedStatus, detail.body ?? '');
          else handlers.onClosed(detail?.code ?? STREAM_DROPPED_CODE, reason);
        },
      },
      // The one extra parameter the route takes, and only when the reader chose to see a held terminal.
      options.reveal === true ? { reveal: '1' } : undefined,
    );
    return {
      write: bytes => socket.send(bytes),
      control: text => socket.send(text),
      close: () => {
        over = true;
        socket.close();
      },
    };
  };

/**
 * The original wording is preserved verbatim: "this box" is the daemon serving
 * the list, which is now one of several a reader may have paired.
 */
export const terminalLimitLabel = (list: TerminalListView): string =>
  `${list.terminals.length}/${list.limits.perSession} in this session · ${list.limits.runningGlobal}/${list.limits.global} on this box`;
