import {
  type CloseTerminalResponse,
  CloseTerminalResponseSchema,
  type CreateTerminalRequest,
  CreateTerminalRequestSchema,
  FY_REQUEST_ID_HEADER,
  RenameTerminalRequestSchema,
  SocketTicketResponseSchema,
  TerminalIdSchema,
  type TerminalListView,
  TerminalListViewSchema,
  type TerminalView,
  TerminalViewSchema,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import type { ConnectionMethod } from '@ferretry/relay';
import type { RelayStreamRequest } from './relay-carrier.ts';
import { type RelayClientSession, type RelayStreamFrame, RelayStreamRefusedError } from './relay-session.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('terminal scope must belong to the requested daemon');
};

const terminalsPath = (scope: DaemonSessionScope): string =>
  `/v1/sessions/${encodeURIComponent(scope.sessionId)}/terminals`;

/**
 * Terminal identity is daemon-issued and lands in a URL path, so it is parsed
 * before use rather than trusted from whichever view supplied it.
 */
const terminalPath = (scope: DaemonSessionScope, terminalId: string): string =>
  `${terminalsPath(scope)}/${encodeURIComponent(TerminalIdSchema.parse(terminalId))}`;

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/**
 * Every terminal call is addressed to exactly one paired daemon. There is no
 * page-relative overload: a session ID reused across two daemons must never
 * resolve to whichever daemon happens to be current.
 */
const terminalJson = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  path: string,
  init: RequestInit,
  fetcher: DaemonFetch,
): Promise<unknown> => {
  assertScopeDaemon(daemon, scope);
  const mutation = (init.method ?? 'GET').toUpperCase() !== 'GET';
  const request = daemonRequest(daemon, path, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(mutation ? { [FY_REQUEST_ID_HEADER]: crypto.randomUUID() } : {}),
    },
  });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return await response.json();
};

const parseTerminal = (scope: DaemonSessionScope, body: unknown): TerminalView => {
  const view = TerminalViewSchema.parse(body);
  if (view.sessionId !== scope.sessionId) throw new DaemonResponseError(502, 'daemon returned another session');
  return view;
};

/** Lists the terminals the paired daemon owns for one of its sessions. */
export const listSessionTerminals = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
): Promise<TerminalListView> => {
  const body = await terminalJson(daemon, scope, terminalsPath(scope), {}, fetcher);
  const list = TerminalListViewSchema.parse(body);
  if (list.sessionId !== scope.sessionId) throw new DaemonResponseError(502, 'daemon listed another session');
  return list;
};

/** Opens a terminal, letting the daemon choose any size the caller omits. */
export const createSessionTerminal = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  request: CreateTerminalRequest = {},
  fetcher: DaemonFetch = browserFetch,
): Promise<TerminalView> => {
  const body = await terminalJson(
    daemon,
    scope,
    terminalsPath(scope),
    { method: 'POST', body: JSON.stringify(CreateTerminalRequestSchema.parse(request)) },
    fetcher,
  );
  return parseTerminal(scope, body);
};

/** Retitles one terminal on the daemon that owns it. */
export const renameSessionTerminal = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
  title: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<TerminalView> => {
  const body = await terminalJson(
    daemon,
    scope,
    terminalPath(scope, terminalId),
    { method: 'PATCH', body: JSON.stringify(RenameTerminalRequestSchema.parse({ title })) },
    fetcher,
  );
  return parseTerminal(scope, body);
};

/** Closes one terminal, confirming the daemon closed the one that was asked for. */
export const closeSessionTerminal = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<CloseTerminalResponse> => {
  const body = await terminalJson(daemon, scope, terminalPath(scope, terminalId), { method: 'DELETE' }, fetcher);
  const closed = CloseTerminalResponseSchema.parse(body);
  if (closed.id !== terminalId) throw new DaemonResponseError(502, 'daemon closed another terminal');
  return closed;
};

/**
 * Buys the short-lived credential a browser WebSocket can actually carry.
 *
 * The device token remains in this header-carrying request; it is never copied into the resulting
 * stream URL. The daemon binds the ticket to this exact `(daemon, session, terminal)` stream, and
 * the local scope assertion prevents a same-named session on another pairing from being substituted.
 */
export const daemonTerminalTicket = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<string> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, `${terminalPath(scope, terminalId)}/stream/ticket`, { method: 'POST' });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return SocketTicketResponseSchema.parse(await response.json()).ticket;
};

/**
 * The daemon route one terminal's stream lives at, credential-free.
 *
 * ONE VALUE, TWO CARRIERS, AND THE TICKET IS NOT PART OF IT. A direct viewer appends a ticket to
 * build a `wss://` URL; a relayed viewer puts this path in its §14 `stream` credential record and
 * appends NOTHING — `docs/relay-protocol.md` §14 refuses `ticket` or `token` in a stream's query with
 * `4400`. Deriving the two separately is exactly how a ticket ends up in a relayed stream's query, so
 * the credential-free path is the shared value and each carrier adds its own.
 */
export const terminalStreamPath = (daemon: DaemonConnection, scope: DaemonSessionScope, terminalId: string): string => {
  assertScopeDaemon(daemon, scope);
  return `${terminalPath(scope, terminalId)}/stream`;
};

/**
 * Builds a viewer URL from a per-connection ticket on the paired daemon.  The
 * device token is deliberately absent: it would outlive the socket in any log
 * or history that retains the URL, and the page origin is never the daemon.
 */
export const terminalStreamUrl = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
  ticket: string,
): string => {
  assertScopeDaemon(daemon, scope);
  if (ticket.trim() === '') throw new Error('terminal stream ticket must not be empty');
  // COMPOSED HERE RATHER THAN CALLED FROM `terminalStreamPath`, AND THE REASON IS A GATE.
  // `scripts/validate/route-agreement.sh` recognises a dial by the path it composes at the call
  // site; behind a helper it sees nothing and reports this route as reached by no client at all —
  // which would be a false statement about a route the deck opens on every attach. The two
  // spellings are kept honest by a test that asserts this URL ends with that path, so the
  // duplication cannot drift silently.
  const url = new URL(`${terminalPath(scope, terminalId)}/stream`, `${daemon.baseUrl}/`);
  if (url.origin !== new URL(daemon.baseUrl).origin)
    throw new Error('terminal stream must remain on the paired daemon');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
};

/* ---------- one terminal stream, whichever carrier reaches the daemon ------- */

/**
 * The live half of a terminal, as the four things a viewer does with one.
 *
 * A PORT RATHER THAN A `WebSocket`, and the reason is not testability. A relayed terminal is a §14
 * stream SESSION over a rendezvous — there is no socket at the daemon's address to hand back, because
 * that address is precisely the one the relay exists because the browser cannot reach. The deck asks
 * for these four operations and gets whichever carrier is live; nothing above this line knows which.
 */
export interface TerminalStream {
  /** Raw keystrokes and pastes. Split at the record budget on a relay; one write on a socket. */
  write(bytes: Uint8Array): void;
  /** One complete control frame — a resize. Never split, because half a message is corruption. */
  control(text: string): void;
  /** Leave deliberately, carrying the taxonomy a direct close frame would. */
  close(code: number, reason: string): void;
}

/**
 * What a viewer is told about its stream, in the vocabulary BOTH carriers can speak.
 *
 * `closed` CARRIES THE STREAM'S OWN CODE AND NEVER THE SESSION'S. On a relay the meaningful code
 * arrives in the sealed `stream-close` record and a `4440` follows it as expected teardown; handing
 * that `4440` up would be handing the deck a number `shouldReopenTerminalStream` reads as "retry",
 * against a stream the daemon deliberately ended. `refused` is separate for the same class of reason:
 * §14 gives `stream-refused` a status so "it is gone" can be told from "the daemon broke", and a
 * viewer that retried a `403` would ask a permanent refusal the same question forever.
 */
export interface TerminalStreamHandlers {
  onOpen(): void;
  onBytes(bytes: Uint8Array): void;
  onClosed(code: number, reason: string): void;
  onRefused(status: number, body: string): void;
}

export type TerminalStreamAttach = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  terminalId: string,
  handlers: TerminalStreamHandlers,
) => Promise<TerminalStream>;

/** Opens one §14 stream session, or answers `null` when this daemon's traffic is not on a rendezvous. */
export type TerminalStreamOpener = (
  daemon: DaemonConnection,
  request: RelayStreamRequest,
) => Promise<RelayClientSession | null>;

/**
 * The direct carrier: a ticket bought over HTTP, then a `wss://` socket at the daemon's own address.
 *
 * Unchanged in every respect that matters — the device token stays in the header-carrying request and
 * never enters the URL — and wrapped in the port so the deck stops knowing which carrier it is on.
 */
const directTerminalStream = (socket: WebSocket, handlers: TerminalStreamHandlers): TerminalStream => {
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', event => {
    if (event.data instanceof ArrayBuffer) handlers.onBytes(new Uint8Array(event.data));
  });
  socket.addEventListener('close', event => handlers.onClosed(event.code, event.reason));
  // `error` is always followed by `close`, which owns the taxonomy and the retry decision.
  socket.addEventListener('error', () => undefined);
  return {
    write: bytes => {
      // Copied onto its own buffer: `send` will not take a view whose buffer might be shared.
      if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array(bytes).buffer);
    },
    control: text => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    close: (code, reason) => socket.close(code, reason),
  };
};

/**
 * The relayed carrier: one §14 stream session, no ticket, and the client's own splitting.
 *
 * NO TICKET IS BOUGHT, and the refusal precedes the purchase rather than following it — §14 refuses
 * `ticket` in a stream's query with `4400`, so one minted here would be a live single-use credential
 * the daemon burned for a surface that will not take it.
 *
 * WRITES ARE SPLIT AND NOTHING IS REASSEMBLED. §14: "a `bytes` record carries a run of an ordered
 * byte stream, delivered to the stream the moment it arrives … a terminal neither knows nor cares
 * whether a paste arrived as one write or three — so there is no reassembly, no fragment marker, and
 * no buffer waiting for a frame to complete." `sendStream` does the splitting at the shared derived
 * budget; a resize goes as one complete text frame and is never split.
 */
const relayTerminalStream = (session: RelayClientSession, handlers: TerminalStreamHandlers): TerminalStream => {
  session.onStreamClosed(closed => handlers.onClosed(closed.code, closed.reason));
  handlers.onOpen();
  return {
    write: bytes => session.sendStream({ kind: 'bytes', bytes }),
    control: text => session.sendStream({ kind: 'text', text }),
    close: (code, reason) => session.closeStream(code, reason),
  };
};

/**
 * Attach to one terminal over whichever carrier this daemon's traffic is measured on.
 *
 * The relay is tried FIRST here, and that is not a reversal of §1's direct-first rule: the carrier
 * has already been decided by a walk that tried direct first, and `openStream` answers `null` for
 * anything that is not a live rendezvous. This is reading a decision, not making one.
 */
export const browserTerminalStreamAttach =
  (
    openStream: TerminalStreamOpener,
    fetcher: DaemonFetch = browserFetch,
    carrier: () => ConnectionMethod | undefined = () => undefined,
  ): TerminalStreamAttach =>
  async (daemon, scope, terminalId, handlers) => {
    const path = terminalStreamPath(daemon, scope, terminalId);
    const session = await openStream(daemon, { path, onData: frame => onStreamFrame(frame, handlers) }).catch(
      relayAttachFailure(handlers),
    );
    if (session !== null && session !== undefined) return relayTerminalStream(session, handlers);
    // NOT UNTIL A CARRIER HAS BEEN MEASURED, the same gate the live event feed already has. A carrier
    // is decided by the first request that walks, and `openStream` answers `null` both for "the
    // winner is direct" and for "no walk has finished". Treating the second as direct buys a
    // single-use ticket and opens a `wss://` at the daemon's own address — the one a relayed browser
    // cannot reach — burning a credential on a socket that can only fail, and recovering through the
    // deck's backoff rather than through anything this function knew.
    if (carrier() === undefined) throw new Error(TERMINAL_STREAM_NO_CARRIER);
    const ticket = await daemonTerminalTicket(daemon, scope, terminalId, fetcher);
    return directTerminalStream(new WebSocket(terminalStreamUrl(daemon, scope, terminalId, ticket)), handlers);
  };

/**
 * Said when a terminal is asked for before any request has measured a carrier.
 *
 * It is a RETRYABLE failure rather than a refusal: the deck's ordinary backoff is exactly right here,
 * because the next request to walk decides the carrier and the attach after it will succeed.
 */
export const TERMINAL_STREAM_NO_CARRIER =
  'no carrier has been measured for this daemon yet, so there is nothing to attach a terminal over';

/**
 * A terminal's frames, as the two shapes §14 gives them.
 *
 * Bytes are the shell's output. TEXT ON THIS ROUTE IS THE DAEMON SPEAKING A SHAPE THIS STREAM DOES
 * NOT HAVE — the terminal's text direction is client-to-daemon, for the resize control — so it is
 * dropped rather than written into the emulator, because writing it would put the daemon's own JSON
 * on the reader's screen as if the shell had printed it.
 */
const onStreamFrame = (frame: RelayStreamFrame, handlers: TerminalStreamHandlers): void => {
  if (frame.kind === 'bytes') handlers.onBytes(frame.bytes);
};

/**
 * A relayed attach that did not open, told apart into the two answers a viewer acts on differently.
 *
 * A `stream-refused` is the DAEMON's verdict and is final for this attempt, so the viewer is told
 * through `onRefused` and then this throws `TerminalStreamRefused` — which the deck recognises and
 * does NOT retry. Anything else is a carrier that did not work, and is rethrown unchanged so the
 * deck's ordinary retry takes it.
 *
 * EVERY PATH THROWS, which is why the return type says so. There is no session to hand back either
 * way: a refusal never opened one, and a transport failure never reached one.
 */
const relayAttachFailure =
  (handlers: TerminalStreamHandlers) =>
  (reason: unknown): never => {
    if (!(reason instanceof RelayStreamRefusedError)) throw reason;
    handlers.onRefused(reason.status, reason.body);
    throw new TerminalStreamRefused(reason.status, reason.body);
  };

/** Marks an attach the daemon refused, so the deck reports it instead of retrying it forever. */
export class TerminalStreamRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`the daemon refused this terminal stream: ${status}`);
    this.name = 'TerminalStreamRefused';
  }
}

/**
 * The original wording is preserved verbatim: "this box" is the daemon serving
 * the list, which is now one of several a reader may have paired.
 */
export const terminalLimitLabel = (list: TerminalListView): string =>
  `${list.terminals.length}/${list.limits.perSession} in this session · ${list.limits.runningGlobal}/${list.limits.global} on this box`;
