import {
  type CloseTerminalResponse,
  CloseTerminalResponseSchema,
  type CreateTerminalRequest,
  CreateTerminalRequestSchema,
  FY_REQUEST_ID_HEADER,
  type InputQuarantineList,
  InputQuarantineListSchema,
  RenameTerminalRequestSchema,
  SESSION_CONSOLE_INPUT_MAX,
  SessionConsoleInputRequestSchema,
  SessionConsoleInputResultSchema,
  TerminalIdSchema,
  type TerminalListView,
  TerminalListViewSchema,
  type TerminalView,
  TerminalViewSchema,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
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

/** Lists the terminals of a session that were just handed a secret and are hidden from the agent. */
export const listSessionQuarantines = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
): Promise<InputQuarantineList> =>
  InputQuarantineListSchema.parse(
    await terminalJson(
      daemon,
      scope,
      `/v1/sessions/${encodeURIComponent(scope.sessionId)}/input-quarantines`,
      { method: 'GET' },
      fetcher,
    ),
  );

/** Ends one quarantine early, by the terminal's key or id; the daemon audits who ended it. */
export const endSessionQuarantine = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  key: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<void> => {
  const body = await terminalJson(
    daemon,
    scope,
    `/v1/sessions/${encodeURIComponent(scope.sessionId)}/input-quarantines/${encodeURIComponent(key)}/end`,
    { method: 'POST' },
    fetcher,
  );
  if ((body as { ended?: unknown } | null)?.ended !== true)
    throw new DaemonResponseError(502, 'daemon did not end the quarantine');
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
 * Types into the session's OWN pane — the Console — on the daemon that owns it.
 *
 * Governed as a terminal is (`terminal.use`): a paired device needs the grant and its unlock, and a
 * refusal comes back as the same grant error a terminal open would raise. A long paste is sent as
 * ordered writes, each one awaited, so the pane receives it in the order it was typed.
 */
export const typeIntoSessionConsole = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  data: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<number> => {
  let written = 0;
  for (const chunk of consoleInputChunks(data)) {
    const body = await terminalJson(
      daemon,
      scope,
      `/v1/sessions/${encodeURIComponent(scope.sessionId)}/console/input`,
      { method: 'POST', body: JSON.stringify(SessionConsoleInputRequestSchema.parse({ data: chunk })) },
      fetcher,
    );
    written += SessionConsoleInputResultSchema.parse(body).written;
  }
  return written;
};

/* ---------- one terminal stream, whichever carrier reaches the daemon ------- */

/**
 * The live half of a terminal, as the four things a viewer does with one.
 *
 * A PORT RATHER THAN A `WebSocket`, and the reason is not testability. A terminal is a §14 stream
 * SESSION on whichever carrier reaches the daemon — its own address or a rendezvous — so there is no
 * bare socket to hand back. The deck asks for these four operations and nothing above this line knows
 * which carrier carries them.
 */
export interface TerminalStream {
  /** Raw keystrokes and pastes, split at the record budget. */
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
  options?: TerminalAttachOptions,
) => Promise<TerminalStream>;

/** `reveal` asks the daemon to show THIS viewer a quarantined terminal. It is per connection and audited. */
export interface TerminalAttachOptions {
  readonly reveal?: boolean;
}

/** Opens one §14 stream session on whichever carrier reaches the daemon. */
export type TerminalStreamOpener = (
  daemon: DaemonConnection,
  request: RelayStreamRequest,
) => Promise<RelayClientSession>;

/**
 * One terminal as one §14 stream session: no ticket, and the client's own splitting.
 *
 * NO TICKET EXISTS any more. A paired device opens its streams inside its own session, where the
 * credential is the device's signed proof, and the daemon sells no device a ticket.
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
 * Attach to one terminal over whichever carrier reaches this daemon.
 *
 * The router opens the stream on the carrier a request has already measured, or walks the set itself
 * — direct first, then each rendezvous — when none has. Either way the attach is a stream session the
 * device key opened, so there is no second, ticketed path for a direct viewer any more.
 */
export const browserTerminalStreamAttach =
  (openStream: TerminalStreamOpener): TerminalStreamAttach =>
  async (daemon, scope, terminalId, handlers, options = {}) => {
    assertScopeDaemon(daemon, scope);
    // COMPOSED AT THE CALL, credential-free, so the route-agreement gate sees this dial: it recognises a request by the path written in the call's own arguments, and behind a
    // helper it would report the terminal stream as reached by no client at all.
    const session = await openStream(daemon, {
      path: `${terminalPath(scope, terminalId)}/stream`,
      ...(options.reveal === true ? { query: [['reveal', '1']] as const } : {}),
      onData: frame => onStreamFrame(frame, handlers),
    }).catch(relayAttachFailure(handlers));
    return relayTerminalStream(session, handlers);
  };

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
 * An attach that did not open, told apart into the two answers a viewer acts on differently.
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
